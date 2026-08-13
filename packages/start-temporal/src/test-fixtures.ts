import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Module, Port, Provider } from "@btravstack/di";
import { start, type RunningApp, type RuntimeHost } from "@btravstack/start";
import type { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { expect, test } from "vitest";

import { temporalRuntime, type TemporalInfo } from "./temporal-runtime.js";

/**
 * The time-skipping server binary, cached where we decide rather than in the
 * OS temp directory — which CI wipes between jobs and macOS purges on its own
 * schedule — and with a year-long ttl rather than the SDK's one day.
 */
const downloadDir = fileURLToPath(
  new URL("../../../.cache/temporal-test-server/", import.meta.url),
);
mkdirSync(downloadDir, { recursive: true });

export class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

type App = RunningApp<never, TemporalInfo>;

let queueSeq = 0;
const nextTaskQueue = (): string => `t-${(queueSeq += 1)}-${process.pid}`;

type ActivityBuilder = (
  host: RuntimeHost<typeof Greeting>,
) => Record<string, (...args: never[]) => unknown>;

const defaultActivities: ActivityBuilder = () => ({
  echo: (value: string) => Promise.resolve(value),
});

export type TemporalFixtures = {
  readonly serve: (build?: ActivityBuilder) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
  }>;
  readonly serveBroken: () => Promise<App>;
};

export const it = test.extend<TemporalFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serve: async ({}, use) => {
    const env = await TestWorkflowEnvironment.createTimeSkipping({
      server: {
        executable: { type: "cached-download", downloadDir, ttl: "365d" },
      },
    });
    const started: App[] = [];

    await use(async (build) => {
      const taskQueue = nextTaskQueue();
      const app = start(AppModule, {
        runtime: temporalRuntime({
          connection: env.nativeConnection,
          taskQueue,
          workflows: {
            workflowsPath: fileURLToPath(new URL("./test-workflows.ts", import.meta.url)),
          },
          activities: build ?? defaultActivities,
          needs: [Greeting],
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);
      await app.runtimeInfo();
      return { app, client: env.client, taskQueue };
    });

    // `env.teardown()` must run even if an app assertion below throws —
    // otherwise the time-skipping server process leaks (see git history for
    // the carried finding this fixes).
    try {
      for (const app of started) {
        app.stop();
        await expect(app.exited).toBeOk();
      }
    } finally {
      await env.teardown();
    }
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serveBroken: async ({}, use) => {
    const env = await TestWorkflowEnvironment.createTimeSkipping({
      server: {
        executable: { type: "cached-download", downloadDir, ttl: "365d" },
      },
    });
    const started: App[] = [];

    await use(() => {
      const app = start(AppModule, {
        runtime: temporalRuntime({
          connection: env.nativeConnection,
          taskQueue: nextTaskQueue(),
          workflows: {
            workflowsPath: fileURLToPath(new URL("./does-not-exist.js", import.meta.url)),
          },
          activities: defaultActivities,
          needs: [Greeting],
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
      });
      started.push(app);
      return Promise.resolve(app);
    });

    // Same fix as `serve`: `env.teardown()` must run regardless of whether
    // the assertion below throws.
    try {
      for (const app of started) {
        app.stop();
        await expect(app.exited).toBeErr();
      }
    } finally {
      await env.teardown();
    }
  },
});
