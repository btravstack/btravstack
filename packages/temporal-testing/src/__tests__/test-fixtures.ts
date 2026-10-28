import { Client, Connection } from "@temporalio/client";
import { test, vi } from "vitest";
import type { TestProject } from "vitest/node";

import { temporalEnvironment, temporalServer, type TemporalEnvironment } from "../index.js";

/** How one `start()` attempt goes: refused with a Docker status, failed for good, or started. */
export type Attempt = { readonly refused: number } | { readonly failed: string } | "starts";

/** What one `temporalServer` run did, with its teardown already run when setup succeeded. */
export type ServerRun = {
  readonly outcome: string;
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

export type TemporalTestingFixtures = {
  /** This package's own environment: the shared server and this file's namespace. */
  readonly temporal: TemporalEnvironment;
  /** A client in this file's namespace. */
  readonly client: Client;
  /** A client in the server's `default` namespace. */
  readonly foreign: Client;
  /** `temporalServer` run over a fake `testcontainers`, each `start()` going as `attempts` say, then torn down. */
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
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  runServer: async ({}, use) => {
    await use(async (options, attempts = ["starts"]) => {
      const fake = fakeContainersOf(attempts);
      vi.doMock("testcontainers", () => fake.module);
      const provided: Record<string, unknown> = {};
      const project = {
        provide: (key: string, value: unknown) => {
          provided[key] = value;
        },
      } as unknown as TestProject;
      const outcome = await temporalServer(options)(project).then(
        (teardown) =>
          teardown === undefined
            ? "ok, left running"
            : teardown().then(
                () => "ok, stopped",
                (cause: Error) => `teardown failed: ${cause.message}`,
              ),
        (cause: Error) => `failed: ${cause.message}`,
      );
      return { outcome, provided, events: fake.events, configured: fake.configured };
    });
    vi.doUnmock("testcontainers");
    vi.unstubAllEnvs();
  },
});

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
