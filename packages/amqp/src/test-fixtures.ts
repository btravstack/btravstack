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
import { declareHandler, type WorkerInferHandlers } from "@amqp-contract/worker";
import {
  RuntimePort,
  start,
  type RunningApp,
  type Runtime,
  type RuntimeHost,
  type UnitMeta,
} from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { expect, type TestAPI } from "vitest";
import { z } from "zod";

import { amqpRuntime, type AmqpInfo, type AmqpOptions } from "./amqp-runtime.js";
import { messageUnits, type MessageMiddleware, type MessageUnitContext } from "./message-units.js";

const echoExchange = defineExchange("amqp-test");
const echoDlx = defineExchange("amqp-test-dlx", { type: "direct" });
const echoQueue = defineQueue("amqp-echo", {
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

/**
 * The runtime is a service the module provides, so each fixture composes the
 * application with the consumer it is testing — the same shape a real
 * deployment's composition root has, sized for one test.
 */
class ConsumerRuntime extends RuntimePort<Runtime<typeof Greeting, AmqpInfo>> {}

const consuming = (runtime: Runtime<typeof Greeting, AmqpInfo>) =>
  Module("Consuming")({
    imports: [AppModule],
    provides: [Provider(ConsumerRuntime)({ value: runtime })],
    exports: [ConsumerRuntime, Greeting],
  });

type App = RunningApp<never, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number };

type BuiltHandlers = {
  readonly handlers: WorkerInferHandlers<typeof echoContract, MessageUnitContext<typeof Greeting>>;
  readonly middleware?: MessageMiddleware<typeof Greeting> | undefined;
};

/**
 * The middleware slot's identity when a test deliberately leaves it unset —
 * `next()` unchanged, exactly what `TypedAmqpWorker.create` does on its own
 * when no `middleware` key is passed at all. `AmqpOptions.middleware`'s
 * builder, once supplied, must always produce a real `MessageMiddleware`
 * (Blocker D closed the `unknown` hole that let it produce nothing), so a
 * `BuiltHandlers` that omits one still needs something to hand `amqpRuntime`.
 */
const passthroughMiddleware: MessageMiddleware<typeof Greeting> = (_args, next) =>
  next() as AsyncResult<unknown, never>;

/**
 * Handlers declared the way a consumer declares them — through
 * `declareHandler`, with `messageUnits` as the one line added — plus a
 * **recording proxy** over the host.
 *
 * The proxy is what makes the meta assertable: `currentUnit()` exposes the
 * kernel's own `unitId` counter, not the `UnitMeta` the runtime passed, so
 * reading it back through the ambient record could only ever assert
 * `expect.any(String)` — which would test nothing.
 */
const seamOf = () => {
  const seen: UnitMeta[] = [];
  let greeting = "";

  // The type argument is required, not stylistic: `declareHandler` infers
  // `TContext` from the handler function it is passed, and a call with
  // nothing to infer from defaults it to `EmptyContext`, leaving
  // `context.ctx` untyped — the same trap `messageUnits` documents below.
  const echoHandler = declareHandler<
    typeof echoContract,
    "echo",
    MessageUnitContext<typeof Greeting>
  >(echoContract, "echo", (_message, _raw, { context }) => {
    greeting = context.ctx.get(Greeting).text;
    return OkAsync(undefined);
  });

  return {
    build: (host: RuntimeHost<typeof Greeting>): BuiltHandlers => {
      const watched: RuntimeHost<typeof Greeting> = {
        ctx: host.ctx,
        run: (meta, work) => {
          seen.push(meta);
          return host.run(meta, work);
        },
      };
      return {
        handlers: { echo: echoHandler },
        middleware: messageUnits<typeof Greeting>(watched),
      };
    },
    seen: (): readonly UnitMeta[] => seen,
    greeting: (): string => greeting,
  };
};

/**
 * A handler that never finishes until `release()` is called, and whose
 * `arrived` promise reports the moment the delivery reached it. Both drain
 * specs turn on knowing a unit is genuinely in flight before the drain
 * starts — polling a wall clock instead would be the flake. Built on the same
 * `declareHandler` + `messageUnits` shape as `seam`, minus the recording proxy
 * `seam` needs and this does not.
 */
const gatedHandler = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  const echoHandler = declareHandler<
    typeof echoContract,
    "echo",
    MessageUnitContext<typeof Greeting>
  >(echoContract, "echo", () => {
    entered();
    return fromSafePromise(held.then(() => undefined));
  });

  return {
    build: (host: RuntimeHost<typeof Greeting>): BuiltHandlers => ({
      handlers: { echo: echoHandler },
      middleware: messageUnits<typeof Greeting>(host),
    }),
    arrived,
    release: () => release(),
  };
};

export type AmqpFixtures = {
  readonly serve: (
    build: (host: RuntimeHost<typeof Greeting>) => BuiltHandlers,
    options?: ServeOptions,
  ) => Promise<App>;
  readonly serveBroken: () => Promise<App>;
  /**
   * Starts a worker whose `handlers` or `middleware` builder throws — never
   * dialling the broker at all, since a throwing builder is qualified before
   * `TypedAmqpWorker.create` runs. Synchronous, unlike `serve`/`serveBroken`:
   * there is no `runtimeInfo()` to await, because the runtime never reaches
   * serving.
   */
  readonly serveFailingBuild: (
    overrides: Partial<
      Pick<AmqpOptions<typeof echoContract, typeof Greeting>, "handlers" | "middleware">
    >,
  ) => App;
  readonly seam: ReturnType<typeof seamOf>;
  readonly gate: ReturnType<typeof gatedHandler>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  serve: async ({ amqpConnectionUrl }, use) => {
    const started: App[] = [];

    await use(async (build, options) => {
      const app = start(
        consuming(
          amqpRuntime({
            urls: [amqpConnectionUrl],
            contract: echoContract,
            handlers: (host) => build(host).handlers,
            middleware: (host) => build(host).middleware ?? passthroughMiddleware,
            needs: [Greeting],
          }),
        ),
        {
          signals: false,
          probes: false,
          preDrainDelayMs: 0,
          onEvent: () => {},
          ...options,
        },
      );
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
      // A port nothing listens on: amqp-connection-manager retries the
      // connect on its own reconnect clock regardless of the failure mode
      // (ECONNREFUSED included — it is built for HA, not for failing fast),
      // so `TypedAmqpWorker.create` only settles once `connectTimeoutMs`
      // gives up and reports the DEFECT the runtime recovers. Set short so
      // this test fails fast instead of waiting out the library's 30s
      // default.
      const app = start(
        consuming(
          amqpRuntime({
            urls: ["amqp://127.0.0.1:1"],
            contract: echoContract,
            handlers: () => ({ echo: () => OkAsync(undefined) }),
            needs: [Greeting],
            connectTimeoutMs: 2_000,
          }),
        ),
        { signals: false, probes: false, preDrainDelayMs: 0, onEvent: () => {} },
      );
      started.push(app);
      return Promise.resolve(app);
    });

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeErr();
    }
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  serveFailingBuild: async ({}, use) => {
    const started: App[] = [];

    await use((overrides) => {
      // A port nothing listens on, and — unlike `serveBroken` — never
      // dialled: `handlers`/`middleware` are qualified before
      // `TypedAmqpWorker.create` ever runs, so a throw in either never
      // reaches the connection attempt at all.
      const app = start(
        consuming(
          amqpRuntime({
            urls: ["amqp://127.0.0.1:1"],
            contract: echoContract,
            handlers: () => ({ echo: () => OkAsync(undefined) }),
            needs: [Greeting],
            ...overrides,
          }),
        ),
        { signals: false, probes: false, preDrainDelayMs: 0, onEvent: () => {} },
      );
      started.push(app);
      return app;
    });

    for (const app of started) {
      app.stop();
      await expect(app.exited).toBeErr();
    }
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  seam: async ({}, use) => {
    await use(seamOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    const handler = gatedHandler();
    await use(handler);
    handler.release();
  },
});
