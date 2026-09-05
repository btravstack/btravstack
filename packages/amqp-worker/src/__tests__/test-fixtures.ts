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
import type { WorkerInferConsumerHandler } from "@amqp-contract/worker";
import type { ConfigInvalid, Environment } from "@btravstack/config";
import {
  Observers,
  currentUnit,
  type Attributes,
  type Operation,
  type RunningApp,
  type Settle,
  type UnitRecord,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { bootFixture, type Boot } from "@btravstack/testing";
import { OkAsync, fromSafePromise } from "unthrown";
import type { TestAPI } from "vitest";
import { z } from "zod";

import { AmqpModule } from "../amqp-module.js";
import {
  AmqpConfig,
  AmqpHandlers,
  type AmqpInfo,
  type AnyUnitModule,
  type HandlersPortOf,
} from "../amqp-runtime.js";
import { AmqpHandler, AmqpMessage } from "../handler.js";

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
  provides: [Provider(Greeting)({ inject: {}, value: { text: "hello" } })],
  exports: [Greeting],
});

/** A handlers provider the suite composes in: built from `Greeting`, or from nothing. */
type EchoProvider = Provider<InstanceType<EchoHandlers>, never, Greeting>;

/**
 * Each fixture composes the application with the starter it is testing, through
 * the `AmqpModule` sugar so the suite covers it. `url` is pinned to the test's
 * own broker, so the module reads no environment.
 */
const consuming = (
  url: string,
  handlers: EchoProvider,
  connectTimeoutMs?: number,
  unit?: AnyUnitModule,
) =>
  AmqpModule("Consuming")({
    contract: echoContract,
    handlers,
    url,
    ...(connectTimeoutMs === undefined ? {} : { connectTimeoutMs }),
    // `as never`: `unit` is `AnyUnitModule`, whose own needs are erased to
    // `unknown` — passed through untyped it would poison `AmqpModule`'s
    // inferred `Unit` into an unsatisfiable `unknown` need for every caller
    // of this fixture, unit-bound test or not.
    unit: { message: unit as never },
    imports: [AppModule],
  });

/** Captures the `AmqpConfig` the graph actually bound, for the configuration spec. */
/** One observed operation, as an observer saw it settle. */
export type Observation = {
  readonly component: string;
  readonly name: string;
  readonly attributes: Attributes;
  readonly outcome: "ok" | "error";
};

/** An observer that keeps what it was handed, so a spec asserts on the DIMENSIONS. */
const recordingObserver = (): {
  member: (operation: Operation) => Settle;
  taken: () => readonly Observation[];
} => {
  const taken: Observation[] = [];
  return {
    member:
      ({ component, name, attributes }) =>
      ({ outcome, attributes: settled }) => {
        taken.push({ component, name, attributes: { ...attributes, ...settled }, outcome });
      },
    taken: () => taken,
  };
};

/** The starter over an observer that records — all a graph does to be observed. */
const observedWorker = (
  url: string,
  handlers: EchoProvider,
  member: (operation: Operation) => Settle,
) =>
  AmqpModule("Observed")({
    contract: echoContract,
    handlers,
    url,
    imports: [AppModule],
    provides: [Provider.member(Observers)({ inject: {}, value: member })],
  });

const configuredOf = () => {
  let bound: ServiceOf<AmqpConfig> | undefined;
  return {
    tap: Provider(BoundConfig)({
      inject: { config: AmqpConfig },
      sync: ({ config }) => {
        bound = config;
        return config;
      },
    }),
    bound: (): ServiceOf<AmqpConfig> | undefined => bound,
  };
};

class BoundConfig extends Port("BoundAmqpConfig")<ServiceOf<AmqpConfig>> {}

const plainHandlers: EchoProvider = echoHandlers({
  inject: {},
  value: { echo: () => OkAsync(undefined) },
});

/**
 * A handler whose failure nobody modelled — a defect, which the library nacks
 * straight to the dead-letter queue. The errors half of RED has to see it: a
 * count that omitted defects would be the reassuring half.
 */
const failingHandlers: EchoProvider = echoHandlers({
  inject: {},
  value: { echo: () => fromSafePromise(Promise.reject(new Error("the handler is on fire"))) },
});

type App = RunningApp<ConfigInvalid, AmqpInfo>;

type ServeOptions = { readonly drainTimeoutMs: number; readonly unit?: AnyUnitModule };

class CountingMark extends Port("CountingMark")<{ readonly at: number }> {}

/** A unit module that counts its builds and teardowns, for the fork's own tests. */
const countingUnit = (): {
  readonly module: Module<CountingMark, never, Scope>;
  readonly counts: () => { readonly builds: number; readonly stops: number };
} => {
  const counts = { builds: 0, stops: 0 };
  const module = Module("CountingUnit")({
    provides: [
      Provider(CountingMark)({
        inject: {},
        sync: () => {
          counts.builds += 1;
          return { at: counts.builds };
        },
        onStop: () => {
          counts.stops += 1;
        },
      }),
    ],
    exports: [CountingMark],
  });
  return { module, counts: () => counts };
};

/**
 * Handlers declared the way a consumer declares them, recording what each
 * delivery ran under. `currentUnit()` is the seam: what the handler sees there
 * IS the claim — `traceId` the publisher's message id, or the minted one.
 */
const seamOf = () => {
  const seen: (UnitRecord | undefined)[] = [];
  let greeting = "";

  return {
    handlers: echoHandlers({
      inject: { greeting: Greeting },
      sync: ({ greeting: g }) => ({
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
    inject: {},
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
    inject: {},
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

export class Tenant extends Port("Tenant")<{ readonly id: string }> {}

/** The delivery's own port, as a unit module reads it: one seed, typed by the contract. */
const EchoMessage = AmqpMessage(echoContract);

/**
 * The seeded fork, end to end: a `message` module deriving a tenant from the
 * delivery, and a piece declaring it — so what the handler reads off
 * `context.unit.tenant` can only have come through the seed.
 *
 * `entry` picks which shape the piece hands back. A contract's handler entry is
 * `handler | [handler, ConsumerOptions]`, and `withUnit` has to reach inside the
 * tuple to wrap the function — so the two forms are two code paths, and both
 * are served here rather than only the one every other fixture happens to use.
 */
const scopedOf = (entry: "bare" | "tupled" = "bare") => {
  const seen: string[] = [];

  const module = Module("TenantUnit")({
    needs: [EchoMessage],
    provides: [
      Provider(Tenant)({
        inject: { message: EchoMessage },
        sync: ({ message }) => ({ id: message.payload.value }),
      }),
    ],
    exports: [Tenant],
  });

  const piece = AmqpHandler(
    echoContract,
    "echo",
  )({
    inject: {},
    unit: { tenant: Tenant },
    sync: () => {
      const handler: WorkerInferConsumerHandler<
        typeof echoContract,
        "echo",
        { readonly unit: { readonly tenant: ServiceOf<Tenant> } }
      > = ({ context }) => {
        seen.push(context.unit.tenant.id);
        return OkAsync(undefined);
      };
      return entry === "bare" ? handler : [handler, { prefetch: 1 }];
    },
  });

  return {
    module,
    piece,
    handlers: AmqpHandlers(echoContract)([piece]),
    seen: (): readonly string[] => seen,
  };
};

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
  const units: (readonly string[])[] = [];
  let greeting = "";

  const left = AmqpHandler(
    slicedContract,
    "left",
  )({
    inject: { greeting: Greeting },
    sync:
      ({ greeting: g }) =>
      () => {
        greeting = g.text;
        ran.push("left");
        return OkAsync(undefined);
      },
  });
  const right = AmqpHandler(
    slicedContract,
    "right",
  )({
    inject: {},
    sync:
      () =>
      ({ context }) => {
        ran.push("right");
        units.push(Object.keys(context.unit));
        return OkAsync(undefined);
      },
  });

  return {
    handlers: AmqpHandlers(slicedContract)([left, right]),
    pieces: [left, right] as const,
    ran: (): readonly string[] => ran,
    /** What `right` found on `context.unit` — nothing declared, no module bound. */
    units: (): readonly (readonly string[])[] => units,
    greeting: (): string => greeting,
  };
};

export type AmqpFixtures = {
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /** Boots the starter over `handlers` — a record that acks everything when none is given. */
  readonly serve: (handlers?: EchoProvider, options?: ServeOptions) => Promise<App>;
  readonly serveBroken: () => Promise<App>;
  /** The `AmqpConfig` a graph binds from `env` alone, nothing pinned. */
  readonly boundFrom: (env: Environment) => Promise<ServiceOf<AmqpConfig> | undefined>;
  readonly seam: ReturnType<typeof seamOf>;
  readonly gate: ReturnType<typeof gatedHandler>;
  /** A handler that waits on the unit's own `AbortSignal`, read off the ambient record. */
  readonly deadline: ReturnType<typeof deadlineHandler>;
  readonly slices: ReturnType<typeof slicesOf>;
  readonly serveSliced: (slices: ReturnType<typeof slicesOf>) => Promise<App>;
  /** A piece reading `context.unit.tenant` out of a `message` module built from the seed. */
  readonly scoped: ReturnType<typeof scopedOf>;
  /** The same piece handing back `[handler, ConsumerOptions]` — `withUnit`'s other path. */
  readonly tupled: ReturnType<typeof scopedOf>;
  readonly serveScoped: (scoped: ReturnType<typeof scopedOf>) => Promise<App>;
  /** The starter served over an observer that records what it was handed. */
  readonly serveObserved: (
    handlers?: EchoProvider,
  ) => Promise<{ readonly app: App; readonly taken: () => readonly Observation[] }>;
  /** The handlers whose one consumer fails in a way nobody modelled. */
  readonly failing: EchoProvider;
  /** A unit module counting its builds and teardowns, to bind on `serve`'s `unit`. */
  readonly counting: ReturnType<typeof countingUnit>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  boot: bootFixture(),
  serve: async ({ amqpConnectionUrl, boot }, use) => {
    await use(async (handlers = plainHandlers, options) => {
      const app = boot(consuming(amqpConnectionUrl, handlers, undefined, options?.unit), options);
      // `runtimeInfo()` resolves once the worker is consuming — await it here
      // so the caller's test body never races the worker's own startup.
      await app.runtimeInfo();
      return app;
    });
  },
  serveObserved: async ({ amqpConnectionUrl, boot }, use) => {
    await use(async (handlers = plainHandlers) => {
      const observer = recordingObserver();
      const app = boot(observedWorker(amqpConnectionUrl, handlers, observer.member));
      await app.runtimeInfo();
      return { app, taken: observer.taken };
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  failing: async ({}, use) => {
    await use(failingHandlers);
  },
  boundFrom: async ({ boot }, use) => {
    await use(async (env) => {
      const configured = configuredOf();
      const app = boot(
        AmqpModule("Bound")({
          contract: echoContract,
          handlers: plainHandlers,
          imports: [AppModule],
          provides: [configured.tap],
        }),
        { env },
      );
      await app.runtimeInfo();
      return configured.bound();
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
  // oxlint-disable-next-line no-empty-pattern -- see above
  scoped: async ({}, use) => {
    await use(scopedOf());
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  tupled: async ({}, use) => {
    await use(scopedOf("tupled"));
  },
  serveScoped: async ({ amqpConnectionUrl, boot }, use) => {
    await use(async (scoped) => {
      const app = boot(
        AmqpModule("Scoped")({
          contract: echoContract,
          handlers: scoped.handlers,
          url: amqpConnectionUrl,
          provides: [scoped.piece],
          unit: { message: scoped.module },
        }),
      );
      await app.runtimeInfo();
      return app;
    });
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  counting: async ({}, use) => {
    await use(countingUnit());
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
