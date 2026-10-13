import { randomUUID } from "node:crypto";

import { msToTs } from "@temporalio/common";
import { NativeConnection } from "@temporalio/worker";
import type {} from "vitest";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  // oxlint-disable-next-line typescript/consistent-type-definitions -- a module augmentation must be an interface; a type alias cannot merge
  interface ProvidedContext {
    __BTRAVSTACK_TEMPORAL_ADDRESS__: string;
  }
}

/** Options for {@link temporalServer}. */
export type TemporalServerOptions = {
  /**
   * How long each container may take to report healthy, in milliseconds.
   * `temporalio/auto-setup` creates its schemas on first boot, which a loaded
   * Docker host can stretch well past a minute.
   *
   * @defaultValue `300_000`
   */
  readonly startupTimeoutMs?: number;
};

/** The environment a spec spreads into `start`'s `env`: the server, and a namespace of the spec file's own. */
export type TemporalEnvironment = {
  readonly TEMPORAL_ADDRESS: string;
  readonly TEMPORAL_NAMESPACE: string;
};

const POSTGRES_IMAGE = "postgres:18.1";
const TEMPORAL_IMAGE = "temporalio/auto-setup:1.29.1";
const NAMESPACE_READY_MS = 60_000;

/**
 * A Vitest `globalSetup`: one PostgreSQL and one `temporalio/auto-setup`
 * container for the whole run, started through `testcontainers` and stopped
 * when the run ends. The package's `/testing` entry default-exports it with
 * the default options, so `globalSetup: ["@btravstack/temporal-worker/testing"]`
 * is the whole configuration.
 *
 * @example
 * ```ts
 * // temporal-setup.ts, for a host that needs a longer budget
 * import { temporalServer } from "@btravstack/temporal-worker/testing";
 *
 * export default temporalServer({ startupTimeoutMs: 600_000 });
 * ```
 */
export const temporalServer =
  ({ startupTimeoutMs = 300_000 }: TemporalServerOptions = {}) =>
  async ({ provide }: TestProject): Promise<() => Promise<void>> => {
    const { GenericContainer, Network, Wait } = await import("testcontainers");
    const healthCheck = {
      interval: 1_000,
      retries: Math.ceil(startupTimeoutMs / 1_000),
      startPeriod: startupTimeoutMs,
      timeout: 5_000,
    };
    const password = randomUUID();
    const started: { stop: () => Promise<unknown> }[] = [];
    // Every resource is stopped even when an earlier stop fails, so one
    // container that will not stop cannot leave the others running.
    const stopAll = async (): Promise<unknown[]> => {
      const failures: unknown[] = [];
      for (const resource of started.toReversed())
        await resource.stop().then(undefined, (failure: unknown) => failures.push(failure));
      return failures;
    };
    const teardown = async (): Promise<void> => {
      const failures = await stopAll();
      if (failures.length > 0)
        // oxlint-disable-next-line unthrown/no-throw -- a Vitest `globalSetup` teardown reports failure by rejecting; there is no Result channel here
        throw new AggregateError(
          failures,
          "[temporal-worker] the Temporal test server did not stop cleanly",
        );
    };

    try {
      const network = await new Network().start();
      started.push(network);
      started.push(
        await new GenericContainer(POSTGRES_IMAGE)
          .withNetwork(network)
          .withNetworkAliases("postgres")
          .withEnvironment({
            POSTGRES_DB: "temporal",
            POSTGRES_USER: "temporal",
            POSTGRES_PASSWORD: password,
          })
          .withHealthCheck({ test: ["CMD-SHELL", "pg_isready -U temporal"], ...healthCheck })
          .withWaitStrategy(Wait.forHealthCheck())
          .withStartupTimeout(startupTimeoutMs)
          .start(),
      );
      const temporal = await new GenericContainer(TEMPORAL_IMAGE)
        .withNetwork(network)
        .withExposedPorts(7233)
        .withEnvironment({
          DB: "postgres12",
          DB_PORT: "5432",
          POSTGRES_SEEDS: "postgres",
          POSTGRES_USER: "temporal",
          POSTGRES_PWD: password,
          BIND_ON_IP: "0.0.0.0",
          TEMPORAL_BROADCAST_ADDRESS: "127.0.0.1",
        })
        .withHealthCheck({
          test: ["CMD-SHELL", "tctl --address 127.0.0.1:7233 workflow list"],
          ...healthCheck,
        })
        .withWaitStrategy(Wait.forHealthCheck())
        .withStartupTimeout(startupTimeoutMs)
        .start();
      started.push(temporal);
      provide(
        "__BTRAVSTACK_TEMPORAL_ADDRESS__",
        `${temporal.getHost()}:${temporal.getMappedPort(7233)}`,
      );
      return teardown;
    } catch (cause) {
      const failures = await stopAll();
      // oxlint-disable-next-line unthrown/no-throw -- a Vitest `globalSetup` reports failure by rejecting; there is no Result channel here
      throw failures.length === 0
        ? cause
        : new AggregateError(
            [cause, ...failures],
            "[temporal-worker] the Temporal test server failed to start, and what had started did not stop cleanly",
          );
    }
  };

export default temporalServer();

/**
 * Registering a namespace is not the same as being able to use one: each
 * Temporal service refreshes its namespace registry on its own interval, so a
 * namespace-scoped read is retried until it answers, and its last error is
 * what a namespace that never becomes usable fails with.
 */
const registerNamespace = async (address: string, prefix: string): Promise<string> => {
  const { vi } = await import("vitest");
  const namespace = `${prefix}-${randomUUID()}`;
  const connection = await NativeConnection.connect({ address });
  try {
    await connection.workflowService.registerNamespace({
      namespace,
      workflowExecutionRetentionPeriod: msToTs("1 day"),
    });
    await vi.waitFor(() => connection.workflowService.countWorkflowExecutions({ namespace }), {
      timeout: NAMESPACE_READY_MS,
      interval: 250,
    });
    return namespace;
  } finally {
    await connection.close();
  }
};

/**
 * A file-scoped Vitest fixture answering the {@link TemporalEnvironment} of a
 * namespace registered for the spec file, on the server {@link temporalServer}
 * started. The namespace is the isolation boundary: the starter reads its task
 * queue off the contract, so two spec files polling the same queue are kept
 * apart by namespace, and nothing is cleaned up — the run's end disposes.
 *
 * @example
 * ```ts
 * export const it = test.extend<{ temporal: TemporalEnvironment; boot: Boot }>({
 *   temporal: temporalEnvironment("orders"),
 *   boot: bootFixture(),
 * });
 *
 * it("fulfils", async ({ temporal, boot }) => {
 *   const app = boot(OrderWorker, { env: { ...temporal } });
 * });
 * ```
 */
export const temporalEnvironment = (
  prefix = "spec",
): [
  (context: object, use: (environment: TemporalEnvironment) => Promise<void>) => Promise<void>,
  { scope: "file" },
] => [
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  async ({}: object, use: (environment: TemporalEnvironment) => Promise<void>): Promise<void> => {
    const { inject } = await import("vitest");
    const address = inject("__BTRAVSTACK_TEMPORAL_ADDRESS__");
    await use({
      TEMPORAL_ADDRESS: address,
      TEMPORAL_NAMESPACE: await registerNamespace(address, prefix),
    });
  },
  { scope: "file" },
];
