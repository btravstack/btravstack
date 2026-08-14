import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { start, type RunningApp, type RuntimeHost, type UnitMeta } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { declareActivitiesHandler } from "@temporal-contract/worker/activity";
import { activityInfo } from "@temporalio/activity";
import type { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { OkAsync, fromSafePromise } from "unthrown";
import { expect, test } from "vitest";
import { z } from "zod";

import { activityUnits } from "./activity-units.js";
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

/**
 * The smallest contract that exercises the seam: one workflow, one activity,
 * whose flat runtime name is what `test-workflows.ts` proxies.
 */
const echoContract = defineContract({
  taskQueue: "echo",
  workflows: {
    runEcho: defineWorkflow({
      input: z.string(),
      output: z.string(),
      idempotency: "allow-duplicate",
      activities: {
        echo: defineActivity({
          input: z.string(),
          output: z.string(),
          activityOptions: { startToCloseTimeout: "30 seconds", retry: { maximumAttempts: 1 } },
        }),
      },
    }),
  },
});

/**
 * Activities declared the way a consumer declares them — through
 * `declareActivitiesHandler`, with `activityUnits` as the one line added — plus
 * a **recording proxy** over the host.
 *
 * The proxy is what makes the meta assertable: `currentUnit()` exposes the
 * kernel's own `unitId` counter, not the `UnitMeta` the runtime passed, so
 * reading it back through the ambient record could only ever assert
 * `expect.any(String)` — which would test nothing.
 */
const contractSeamOf = () => {
  const seen: UnitMeta[] = [];
  let taskToken = "";
  let greeting = "";

  return {
    build: (host: RuntimeHost<typeof Greeting>) => {
      const watched: RuntimeHost<typeof Greeting> = {
        ctx: host.ctx,
        run: (meta, work) => {
          seen.push(meta);
          return host.run(meta, work);
        },
      };

      return declareActivitiesHandler({
        contract: echoContract,
        middleware: activityUnits<typeof Greeting>(watched),
        activities: {
          runEcho: {
            echo: (value, { context }) => {
              taskToken = activityInfo().base64TaskToken;
              greeting = context.ctx.get(Greeting).text;
              return OkAsync(value);
            },
          },
        },
      });
    },
    seen: (): readonly UnitMeta[] => seen,
    taskToken: (): string => taskToken,
    greeting: (): string => greeting,
  };
};

/**
 * The same wiring, but the activity resolves only once `release()` is called
 * and reports its arrival through `arrived`. The drain specs turn on knowing a
 * unit is genuinely in flight before the drain starts — polling a wall clock
 * instead would be the flake.
 */
const gateOf = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    build: (host: RuntimeHost<typeof Greeting>) =>
      declareActivitiesHandler({
        contract: echoContract,
        middleware: activityUnits(host),
        activities: {
          runEcho: {
            echo: (value) => {
              entered();
              return fromSafePromise(held.then(() => value));
            },
          },
        },
      }),
    arrived,
    release: (): void => release(),
  };
};

/** The kernel options a test may override — only the drain budget, so far. */
type ServeOptions = { readonly drainTimeoutMs: number };

export type TemporalFixtures = {
  readonly serve: (
    build?: ActivityBuilder,
    options?: ServeOptions,
  ) => Promise<{
    readonly app: App;
    readonly client: Client;
    readonly taskQueue: string;
  }>;
  readonly serveBroken: (build?: ActivityBuilder) => Promise<App>;
  readonly contractSeam: ReturnType<typeof contractSeamOf>;
  readonly gate: ReturnType<typeof gateOf>;
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

    await use(async (build, options) => {
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
        ...options,
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

    // A builder that throws is served against a workflow module that exists, so
    // the failure under test is the only one available.
    await use((build) => {
      const app = start(AppModule, {
        runtime: temporalRuntime({
          connection: env.nativeConnection,
          taskQueue: nextTaskQueue(),
          workflows: {
            workflowsPath: fileURLToPath(
              new URL(
                build === undefined ? "./does-not-exist.js" : "./test-workflows.ts",
                import.meta.url,
              ),
            ),
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
  // oxlint-disable-next-line no-empty-pattern -- see above
  contractSeam: async ({}, use) => {
    await use(contractSeamOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    const gate = gateOf();
    await use(gate);
    // Released on every exit path, so an activity a test deliberately stranded
    // cannot outlive the test that stranded it.
    gate.release();
  },
});
