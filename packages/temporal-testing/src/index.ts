import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { Connection } from "@temporalio/client";
import { msToTs } from "@temporalio/common";
import type { GenericContainer, StartedTestContainer } from "testcontainers";
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
   * How long the container may take to report healthy, in milliseconds: the
   * Docker health check's start period and retry count, `testcontainers`' own
   * wait, and how long a run refused the shared name waits for the winner's
   * container, all take it.
   *
   * @defaultValue `60_000`
   */
  readonly startupTimeoutMs?: number;
  /**
   * `true` attaches to the server an earlier or a concurrent run on the same
   * Docker host started, and leaves it running for the next one. `false`
   * starts a server for this run alone and stops it when the run ends.
   *
   * @defaultValue `true`
   */
  readonly reuse?: boolean;
};

/** The environment a spec spreads into `start`'s `env`: the server, and a namespace of the spec file's own. */
export type TemporalEnvironment = {
  readonly TEMPORAL_ADDRESS: string;
  readonly TEMPORAL_NAMESPACE: string;
};

const TEMPORAL_IMAGE = "temporalio/temporal:1.9.1";
const RACE_RETRY_MS = 100;
const RACE_RETRY_MAX_MS = 1_000;
const NAMESPACE_READY_MS = 60_000;

/**
 * A Vitest `globalSetup` providing a Temporal server's address: the Temporal
 * CLI's development server, one `temporalio/temporal` container started
 * through `testcontainers`, in memory. The package default-exports it with the
 * default options, so `globalSetup: ["@btravstack/temporal-testing"]` is the
 * whole configuration.
 *
 * By default the container is reused: every run on the Docker host, including
 * concurrent ones in other processes, attaches to one server, which outlives
 * the run. `reuse: false` owns a server for this run instead, and stops it at
 * the run's end.
 *
 * @example
 * ```ts
 * // temporal-setup.ts, for a run that owns its server
 * import { temporalServer } from "@btravstack/temporal-testing";
 *
 * export default temporalServer({ reuse: false });
 * ```
 */
export const temporalServer =
  ({ startupTimeoutMs = 60_000, reuse = true }: TemporalServerOptions = {}) =>
  async ({ provide }: TestProject): Promise<(() => Promise<void>) | undefined> => {
    const { GenericContainer, Wait } = await import("testcontainers");
    const define = (): GenericContainer =>
      new GenericContainer(TEMPORAL_IMAGE)
        .withCommand(["server", "start-dev", "--ip", "0.0.0.0", "--headless"])
        .withExposedPorts(7233)
        .withHealthCheck({
          test: ["CMD", "temporal", "operator", "cluster", "health", "--address", "127.0.0.1:7233"],
          interval: 1_000,
          retries: Math.ceil(startupTimeoutMs / 1_000),
          startPeriod: startupTimeoutMs,
          timeout: 5_000,
        })
        .withWaitStrategy(Wait.forHealthCheck())
        .withStartupTimeout(startupTimeoutMs);
    // testcontainers' own switch: with reuse off, it reaps the container at exit anyway.
    const shared = reuse && process.env["TESTCONTAINERS_REUSE_ENABLE"] !== "false";
    const server = shared
      ? await attach(
          () => define().withReuse().withName(sharedName(startupTimeoutMs)),
          Date.now() + startupTimeoutMs,
        )
      : await define().start();
    provide("__BTRAVSTACK_TEMPORAL_ADDRESS__", `${server.getHost()}:${server.getMappedPort(7233)}`);
    return shared
      ? undefined
      : async () => {
          await server.stop();
        };
  };

export default temporalServer();

/**
 * `testcontainers`' reuse lock is per process, so concurrent first runs all
 * miss the lookup. The name makes Docker the lock: one create wins, the others
 * are refused with `409` (or `304`, starting what the winner created), and a
 * later attempt finds the winner's container. Docker lists it some time after
 * it reserves the name, longer on a loaded host, so the refused run retries
 * with backoff until the startup budget runs out.
 */
const attach = (
  define: () => GenericContainer,
  deadline: number,
  wait = RACE_RETRY_MS,
): Promise<StartedTestContainer> =>
  define()
    .start()
    .catch((cause: unknown) =>
      isRace(cause) && Date.now() < deadline
        ? pause(Math.min(wait, deadline - Date.now())).then(() =>
            attach(define, deadline, Math.min(wait * 2, RACE_RETRY_MAX_MS)),
          )
        : Promise.reject(cause),
    );

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isRace = (cause: unknown): boolean => {
  const status = (cause as { readonly statusCode?: unknown } | undefined)?.statusCode;
  return status === 409 || status === 304;
};

/**
 * Everything `withReuse()` hashes that varies between installs, so a run with
 * other options or another `testcontainers` gets a container of its own rather
 * than colliding with the name of one it cannot reuse.
 */
const sharedName = (startupTimeoutMs: number): string => {
  const { version } = createRequire(import.meta.url)("testcontainers/package.json") as {
    readonly version: string;
  };
  const digest = createHash("sha256")
    .update(JSON.stringify([TEMPORAL_IMAGE, startupTimeoutMs, version]))
    .digest("hex")
    .slice(0, 12);
  return `btravstack-temporal-${digest}`;
};

/**
 * Registering a namespace is not the same as being able to use one: each
 * Temporal service refreshes its namespace registry on its own interval, so a
 * namespace-scoped read is retried until it answers, and its last error is
 * what a namespace that never becomes usable fails with.
 */
const registerNamespace = async (address: string, prefix: string): Promise<string> => {
  const { vi } = await import("vitest");
  const namespace = `${prefix}-${randomUUID()}`;
  const connection = await Connection.connect({ address });
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
 * provided. The namespace is the isolation boundary: the starter reads its task
 * queue off the contract, so two spec files polling the same queue are kept
 * apart by namespace, and so are suites listing workflows on a shared server.
 * Nothing is cleaned up.
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
