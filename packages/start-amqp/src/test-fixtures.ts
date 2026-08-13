import {
  defineContract,
  defineEventConsumer,
  defineEventPublisher,
  defineExchange,
  defineMessage,
  defineQueue,
} from "@amqp-contract/contract";
import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import { Module, Port, Provider } from "@btravstack/di";
import { start, type RunningApp, type RuntimeHost } from "@btravstack/start";
import { OkAsync } from "unthrown";
import { expect, type TestAPI } from "vitest";
import { z } from "zod";

import { amqpRuntime, type AmqpInfo } from "./amqp-runtime.js";

const echoExchange = defineExchange("start-amqp-test");
const echoDlx = defineExchange("start-amqp-test-dlx", { type: "direct" });
const echoQueue = defineQueue("start-amqp-echo", {
  // No queue in this suite's own contract binds to the DLX — nothing here
  // exercises the retry/DLQ path, so `defineContract`'s define-time
  // routability check is told another service owns it, matching the
  // suggestion in its own error message.
  deadLetter: { exchange: echoDlx, externalConsumers: true },
  retry: { mode: "immediate-requeue", maxRetries: 1 },
});
const echoMessage = defineMessage(z.object({ value: z.string() }));
const echoPublished = defineEventPublisher(echoExchange, echoMessage, {
  routingKey: "echo.requested",
});

export const echoContract = defineContract({
  publishers: { echo: echoPublished },
  consumers: { echo: defineEventConsumer(echoPublished, echoQueue) },
});

export class Greeting extends Port("Greeting")<{ readonly text: string }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

type App = RunningApp<never, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number };

export type AmqpFixtures = {
  readonly serve: (
    build: (host: RuntimeHost<typeof Greeting>) => Record<string, unknown>,
    options?: ServeOptions,
  ) => Promise<App>;
  readonly serveBroken: () => Promise<App>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  serve: async ({ amqpConnectionUrl }, use) => {
    const started: App[] = [];

    await use(async (build, options) => {
      const app = start(AppModule, {
        runtime: amqpRuntime({
          urls: [amqpConnectionUrl],
          contract: echoContract,
          handlers: build,
          needs: [Greeting],
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        onEvent: () => {},
        ...options,
      });
      started.push(app);
      // `runtimeInfo()` resolves once the worker is consuming — await it here
      // so the caller's test body never races the worker's own startup.
      await app.runtimeInfo();
      return app;
    });

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeOk();
    }
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  serveBroken: async ({}, use) => {
    const started: App[] = [];

    await use(() => {
      const app = start(AppModule, {
        // A port nothing listens on: amqp-connection-manager retries the
        // connect on its own reconnect clock regardless of the failure mode
        // (ECONNREFUSED included — it is built for HA, not for failing fast),
        // so `TypedAmqpWorker.create` only settles once its own
        // `connectTimeoutMs` (a `CreateWorkerOptions` field distinct from
        // `connectionOptions`, and not part of `AmqpOptions`'s surface here)
        // gives up at its 30s default and reports the DEFECT the runtime
        // recovers. Nothing shortens that from this task's option surface, so
        // the test below is given a timeout to match rather than a broker
        // that fails fast.
        runtime: amqpRuntime({
          urls: ["amqp://127.0.0.1:1"],
          contract: echoContract,
          handlers: () => ({ echo: () => OkAsync(undefined) }),
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

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeErr();
    }
  },
});
