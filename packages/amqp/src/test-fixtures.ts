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
import type { ConfigInvalid } from "@btravstack/config";
import { currentUnit, type RunningApp, type UnitRecord } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { OkAsync, fromSafePromise } from "unthrown";
import type { TestAPI } from "vitest";
import { z } from "zod";

import { AmqpModule } from "./amqp-module.js";
import { AmqpHandlers, type AmqpInfo, type HandlersPortOf } from "./amqp-runtime.js";

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

/** The handlers provider builder the way a consumer gets it: `AmqpHandlers(contract)`, di's own `Provider(port)` on the starter's handlers port, typed for the contract. */
const echoHandlers = AmqpHandlers(echoContract);
type EchoHandlers = HandlersPortOf<typeof echoContract>;

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

/** A handlers provider the suite composes in: built from `Greeting`, or from nothing. */
type EchoProvider = Provider<InstanceType<EchoHandlers>, never, Greeting>;

/**
 * The runtime is a service the module provides, so each fixture composes the
 * application with the starter it is testing — the same shape a real
 * deployment's composition root has, sized for one test — through the
 * `AmqpModule` sugar, so the package's own suite covers it. `url` is pinned to
 * the test's own broker, so the module reads no environment.
 */
const consuming = (url: string, handlers: EchoProvider, connectTimeoutMs?: number) =>
  AmqpModule("Consuming")({
    contract: echoContract,
    handlers,
    url,
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    imports: [AppModule],
  });

const plainHandlers: EchoProvider = echoHandlers({
  value: { echo: () => OkAsync(undefined) },
});

type App = RunningApp<ConfigInvalid, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number };

/**
 * Handlers declared the way a consumer declares them — a provider built from
 * the application's own services, plain functions typed by the contract —
 * that record what each delivery ran under.
 *
 * `currentUnit()` is the seam: the ambient record is what the unit leaves for
 * the adapters that read it, so what the handler sees there IS the claim —
 * `traceId` the publisher's message id, or the minted one when there is none.
 */
const seamOf = () => {
  const seen: (UnitRecord | undefined)[] = [];
  let greeting = "";

  return {
    handlers: echoHandlers([Greeting], {
      sync: (g) => ({
        echo: () => {
          seen.push(currentUnit());
          greeting = g.text;
          return OkAsync(undefined);
        },
      }),
    }),
    seen: (): readonly (UnitRecord | undefined)[] => seen,
    greeting: (): string => greeting,
  };
};

/**
 * A handler that waits on the kernel's own per-unit signal — reached through
 * `currentUnit()`, since a middleware-shaped runtime hands its work no
 * parameter — and reports what it saw. `arrived` is the moment the delivery
 * reached it, so a drain spec knows the unit is genuinely in flight.
 */
const deadlineHandler = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let sawAbort: boolean | undefined;

  const handlers: EchoProvider = echoHandlers({
    value: {
      echo: () => {
        const signal = currentUnit()?.signal;
        entered();
        return fromSafePromise(
          new Promise<void>((done) => {
            signal?.addEventListener(
              "abort",
              () => {
                sawAbort = true;
                done();
              },
              { once: true },
            );
          }),
        );
      },
    },
  });

  return { handlers, arrived, sawAbort: (): boolean | undefined => sawAbort };
};

/**
 * A handler that never finishes until `release()` is called, and whose
 * `arrived` promise reports the moment the delivery reached it. Both drain
 * specs turn on knowing a unit is genuinely in flight before the drain
 * starts — polling a wall clock instead would be the flake.
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

  const handlers: EchoProvider = echoHandlers({
    value: {
      echo: () => {
        entered();
        return fromSafePromise(held.then(() => undefined));
      },
    },
  });

  return { handlers, arrived, release: () => release() };
};

export type AmqpFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /** Boots the starter over `handlers` — a record that acks everything when none is given. */
  readonly serve: (handlers?: EchoProvider, options?: ServeOptions) => Promise<App>;
  readonly serveBroken: () => Promise<App>;
  readonly seam: ReturnType<typeof seamOf>;
  readonly gate: ReturnType<typeof gatedHandler>;
  /** A handler that waits on the unit's own `AbortSignal`, read off the ambient record. */
  readonly deadline: ReturnType<typeof deadlineHandler>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  boot: bootFixture(),
  serve: async ({ amqpConnectionUrl, boot }, use) => {
    await use(async (handlers = plainHandlers, options) => {
      const app = boot(consuming(amqpConnectionUrl, handlers), options);
      // `runtimeInfo()` resolves once the worker is consuming — await it here
      // so the caller's test body never races the worker's own startup.
      await app.runtimeInfo();
      return app;
    });
  },
  serveBroken: async ({ boot }, use) => {
    // A port nothing listens on: amqp-connection-manager retries the
    // connect on its own reconnect clock regardless of the failure mode
    // (ECONNREFUSED included — it is built for HA, not for failing fast),
    // so `TypedAmqpWorker.create` only settles once `connectTimeoutMs`
    // gives up and reports the DEFECT the runtime recovers. Set short so
    // this test fails fast instead of waiting out the library's 30s
    // default.
    await use(() => Promise.resolve(boot(consuming("amqp://127.0.0.1:1", plainHandlers, 2_000))));
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  seam: async ({}, use) => {
    await use(seamOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    const handler = gatedHandler();
    await use(handler);
    handler.release();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  deadline: async ({}, use) => {
    await use(deadlineHandler());
  },
});
