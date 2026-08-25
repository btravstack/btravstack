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

import { AmqpModule } from "../amqp-module.js";
import { AmqpHandlers, type AmqpInfo, type HandlersPortOf } from "../amqp-runtime.js";
import { AmqpHandler } from "../handler.js";

const echoExchange = defineExchange("amqp-test");
const echoDlx = defineExchange("amqp-test-dlx", { type: "direct" });
const echoQueue = defineQueue("amqp-echo", {
  // No queue in this suite's contract binds to the DLX, so `defineContract`'s
  // routability check is told another service owns it.
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
 * Each fixture composes the application with the starter it is testing, through
 * the `AmqpModule` sugar so the suite covers it. `url` is pinned to the test's
 * own broker, so the module reads no environment.
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
 * Handlers declared the way a consumer declares them, recording what each
 * delivery ran under. `currentUnit()` is the seam: what the handler sees there
 * IS the claim — `traceId` the publisher's message id, or the minted one.
 */
const seamOf = () => {
  const seen: (UnitRecord | undefined)[] = [];
  let greeting = "";

  return {
    handlers: echoHandlers(
      { greeting: Greeting },
      {
        sync: ({ greeting: g }) => ({
          echo: () => {
            seen.push(currentUnit());
            greeting = g.text;
            return OkAsync(undefined);
          },
        }),
      },
    ),
    seen: (): readonly (UnitRecord | undefined)[] => seen,
    greeting: (): string => greeting,
  };
};

/**
 * A handler that waits on the kernel's per-unit signal, reached through
 * `currentUnit()`, and reports what it saw. `arrived` is the moment the delivery
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
            // No record at all is the very regression this fixture exists to
            // catch: settle at once so the spec fails on `sawAbort` rather
            // than hanging until the suite's timeout, which would report a
            // slow test instead of a missing signal.
            if (signal === undefined) {
              sawAbort = false;
              done();
              return;
            }
            // An already-aborted signal never fires `abort` again — the same
            // arm `whenAborted` carries in `amqp-runtime.ts`, and the reason
            // a drain deadline of `0` would otherwise strand this delivery.
            if (signal.aborted) {
              sawAbort = true;
              done();
              return;
            }
            signal.addEventListener(
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
 * A handler that never finishes until `release()` is called, and whose `arrived`
 * reports the moment the delivery reached it — the drain specs turn on knowing a
 * unit is genuinely in flight before the drain starts.
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

const leftQueue = defineQueue("amqp-sliced-left", {
  deadLetter: { exchange: echoDlx, externalConsumers: true },
  retry: { mode: "immediate-requeue", maxRetries: 1 },
});
const rightQueue = defineQueue("amqp-sliced-right", {
  deadLetter: { exchange: echoDlx, externalConsumers: true },
  retry: { mode: "immediate-requeue", maxRetries: 1 },
});

/** Two consumers of ONE publisher, on two queues — a broadcast with two subscribers, which is what a sliced worker is. Not exported: only this module's own fixtures build on it, and knip flags an export nothing imports. */
const slicedContract = defineContract({
  publishers: { echo: echoPublished },
  consumers: {
    left: defineEventConsumer(echoPublished, leftQueue),
    right: defineEventConsumer(echoPublished, rightQueue),
  },
});

/**
 * Two slices, composed. `left` declares `Greeting` and `right` declares nothing,
 * so the spec can tell each was built from the ports its OWN provider declared.
 *
 * `pieces` is exposed alongside `handlers` because the composed provider's
 * `deps` are the pieces' PORTS: something still has to REGISTER them, since
 * `flatten` never collects a provider's deps transitively.
 */
const slicesOf = () => {
  const ran: string[] = [];
  let greeting = "";

  const left = AmqpHandler(slicedContract, "left")(
    { greeting: Greeting },
    {
      sync:
        ({ greeting: g }) =>
        () => {
          greeting = g.text;
          ran.push("left");
          return OkAsync(undefined);
        },
    },
  );
  const right = AmqpHandler(
    slicedContract,
    "right",
  )({
    value: () => {
      ran.push("right");
      return OkAsync(undefined);
    },
  });

  return {
    handlers: AmqpHandlers(slicedContract)([left, right]),
    pieces: [left, right] as const,
    ran: (): readonly string[] => ran,
    greeting: (): string => greeting,
  };
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
  readonly slices: ReturnType<typeof slicesOf>;
  readonly serveSliced: (slices: ReturnType<typeof slicesOf>) => Promise<App>;
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
    // A port nothing listens on. amqp-connection-manager retries on its own
    // reconnect clock whatever the failure mode, so `create` only settles once
    // `connectTimeoutMs` gives up — set short, rather than waiting out the
    // library's 30s default.
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
  // oxlint-disable-next-line no-empty-pattern -- see above
  slices: async ({}, use) => {
    await use(slicesOf());
  },
  serveSliced: async ({ amqpConnectionUrl, boot }, use) => {
    await use(async (slices) => {
      const app = boot(
        AmqpModule("Sliced")({
          contract: slicedContract,
          handlers: slices.handlers,
          url: amqpConnectionUrl,
          // The composed provider's own deps are the pieces' PORTS — see
          // `slicesOf`'s comment — so the pieces themselves are what discharge
          // them, same as any other unmet need.
          provides: slices.pieces,
          imports: [AppModule],
        }),
      );
      await app.runtimeInfo();
      return app;
    });
  },
});
