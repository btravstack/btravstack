import { Client, Connection } from "@temporalio/client";
import { inject, test, vi } from "vitest";
import type { TestProject } from "vitest/node";

import { temporalEnvironment, temporalServer, type TemporalEnvironment } from "../index.js";

/** How one `start()` attempt goes: refused with a Docker status, failed for good, or started. */
export type Attempt = { readonly refused: number } | { readonly failed: string } | "starts";

/** What one `temporalServer` run did, with its teardown already run when setup succeeded. */
export type ServerRun = {
  readonly outcome: string;
  /** How long the setup took on the fake clock. */
  readonly elapsedMs: number;
  readonly provided: Readonly<Record<string, unknown>>;
  readonly events: readonly string[];
  readonly configured: readonly Configured[];
};

type Configured = {
  readonly image: string;
  command?: readonly string[];
  healthCheck?: unknown;
  startupTimeoutMs?: number;
  reuse?: boolean;
  name?: string;
};

/** How a piece of work settled on the fake clock. */
export type FakeClockRun<T> = {
  readonly settled: PromiseSettledResult<Awaited<T>>;
  readonly elapsedMs: number;
};

export type TemporalTestingFixtures = {
  /** This package's own environment: the shared server and this file's namespace. */
  readonly temporal: TemporalEnvironment;
  /** A client in this file's namespace. */
  readonly client: Client;
  /** A client in the server's `default` namespace. */
  readonly foreign: Client;
  /** A client in the namespace `run-namespace.setup.ts` registered for the whole run. */
  readonly run: Client;
  /** A connection to the shared server, outside any namespace. */
  readonly connection: Connection;
  /** One workflow task poll of `queue` in `namespace`, answering the polled workflow's id, or `undefined` once the poll times out empty. */
  readonly pollOnce: (namespace: string, queue: string) => Promise<string | undefined>;
  /** The address of a server that registers a namespace, then answers every read of it as `answer` says: `Connection.connect` faked until the test ends. */
  readonly unusableServer: (answer: "not found" | "nothing") => string;
  /** `work` settled on a fake clock that moves only from one timer to the next, and how long it took on that clock. */
  readonly onFakeClock: <T>(work: () => Promise<T>) => Promise<FakeClockRun<T>>;
  /** `temporalServer` run over a fake `testcontainers` and a fake clock, each `start()` going as `attempts` say, then torn down. */
  readonly runServer: (
    options?: Parameters<typeof temporalServer>[0],
    attempts?: readonly Attempt[],
  ) => Promise<ServerRun>;
};

export const it = test.extend<TemporalTestingFixtures>({
  temporal: temporalEnvironment("temporal-testing"),
  client: async ({ temporal }, use) => {
    const connection = await Connection.connect({ address: temporal.TEMPORAL_ADDRESS });
    await use(new Client({ connection, namespace: temporal.TEMPORAL_NAMESPACE }));
    await connection.close();
  },
  foreign: async ({ temporal }, use) => {
    const connection = await Connection.connect({ address: temporal.TEMPORAL_ADDRESS });
    await use(new Client({ connection, namespace: "default" }));
    await connection.close();
  },
  run: async ({ temporal }, use) => {
    const connection = await Connection.connect({ address: temporal.TEMPORAL_ADDRESS });
    await use(new Client({ connection, namespace: inject("runNamespace") }));
    await connection.close();
  },
  connection: async ({ temporal }, use) => {
    const connection = await Connection.connect({ address: temporal.TEMPORAL_ADDRESS });
    await use(connection);
    await connection.close();
  },
  pollOnce: async ({ connection }, use) => {
    await use(async (namespace, queue) => {
      const task = await connection.withDeadline(Date.now() + POLL_MS, () =>
        connection.workflowService.pollWorkflowTaskQueue({
          namespace,
          taskQueue: { name: queue },
          identity: "temporal-testing",
        }),
      );
      return task.workflowExecution?.workflowId ?? undefined;
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  unusableServer: async ({}, use) => {
    const spy = vi.spyOn(Connection, "connect");
    await use((answer) => {
      spy.mockResolvedValue(unusableConnection(answer));
      return "unusable:7233";
    });
    spy.mockRestore();
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  onFakeClock: async ({}, use) => {
    await use(async <T>(work: () => Promise<T>): Promise<FakeClockRun<T>> => {
      vi.useFakeTimers();
      const startedAt = Date.now();
      let run: FakeClockRun<T> | undefined;
      void Promise.allSettled([work()]).then(([settled]) => {
        run = { settled, elapsedMs: Date.now() - startedAt };
      });
      while (run === undefined)
        await (vi.getTimerCount() > 0
          ? vi.advanceTimersToNextTimerAsync()
          : new Promise((resolve) => {
              realSetTimeout(resolve, 1);
            }));
      vi.useRealTimers();
      return run;
    });
    vi.useRealTimers();
  },
  runServer: async ({ onFakeClock }, use) => {
    await use(async (options, attempts = ["starts"]) => {
      const fake = fakeContainersOf(attempts);
      vi.doMock("testcontainers", () => fake.module);
      const provided: Record<string, unknown> = {};
      const project = {
        provide: (key: string, value: unknown) => {
          provided[key] = value;
        },
      } as unknown as TestProject;
      const { settled, elapsedMs } = await onFakeClock(() => temporalServer(options)(project));
      const outcome =
        settled.status === "rejected"
          ? `failed: ${(settled.reason as Error).message}`
          : settled.value === undefined
            ? "ok, left running"
            : await settled.value().then(
                () => "ok, stopped",
                (cause: Error) => `teardown failed: ${cause.message}`,
              );
      return {
        outcome,
        elapsedMs,
        provided,
        events: fake.events,
        configured: fake.configured,
      };
    });
    vi.doUnmock("testcontainers");
    vi.unstubAllEnvs();
  },
});

const POLL_MS = 5_000;

const realSetTimeout = globalThis.setTimeout;

/**
 * A connection whose namespace reads fail with "not found" or never answer,
 * and whose `withDeadline` rejects at the deadline as the SDK's does.
 */
const unusableConnection = (answer: "not found" | "nothing"): Connection =>
  ({
    workflowService: {
      registerNamespace: () => Promise.resolve({}),
      countWorkflowExecutions: () =>
        answer === "not found"
          ? Promise.reject(new Error("Namespace not found"))
          : new Promise(() => undefined),
    },
    withDeadline: <R>(deadline: number, call: () => Promise<R>): Promise<R> =>
      Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error("Deadline exceeded"));
          }, deadline - Date.now());
        }),
      ]),
    close: () => Promise.resolve(),
  }) as unknown as Connection;

/**
 * `testcontainers` as `temporalServer` reaches it, recording what each
 * container was configured with and what each `start()` attempt did.
 */
const fakeContainersOf = (attempts: readonly Attempt[]) => {
  const events: string[] = [];
  const configured: Configured[] = [];
  const pending = [...attempts];
  class GenericContainer {
    readonly #config: Configured;
    constructor(image: string) {
      this.#config = { image };
    }
    withCommand(command: readonly string[]): this {
      this.#config.command = command;
      return this;
    }
    withExposedPorts(): this {
      return this;
    }
    withWaitStrategy(): this {
      return this;
    }
    withHealthCheck(healthCheck: unknown): this {
      this.#config.healthCheck = healthCheck;
      return this;
    }
    withStartupTimeout(startupTimeoutMs: number): this {
      this.#config.startupTimeoutMs = startupTimeoutMs;
      return this;
    }
    withReuse(): this {
      this.#config.reuse = true;
      return this;
    }
    withName(name: string): this {
      this.#config.name = name;
      return this;
    }
    start() {
      configured.push(this.#config);
      const attempt = pending.shift() ?? "starts";
      if (attempt !== "starts" && "refused" in attempt) {
        events.push(`refused ${String(attempt.refused)}`);
        return Promise.reject(
          Object.assign(new Error(`HTTP code ${String(attempt.refused)}`), {
            statusCode: attempt.refused,
          }),
        );
      }
      if (attempt !== "starts") return Promise.reject(new Error(attempt.failed));
      events.push("start");
      return Promise.resolve({
        getHost: () => "localhost",
        getMappedPort: () => 7233,
        stop: () => {
          events.push("stop");
          return Promise.resolve();
        },
      });
    }
  }
  return {
    module: { GenericContainer, Wait: { forHealthCheck: () => ({}) } },
    events,
    configured,
  };
};
