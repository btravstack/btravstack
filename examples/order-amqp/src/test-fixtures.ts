import { it as amqpIt } from "@amqp-contract/testing";
import type { AmqpTestFixtures } from "@amqp-contract/testing/extension";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start-core";
import type { AmqpInfo } from "@btravstack/start-amqp";
import { orderContract } from "@btravstack/start-example-order-amqp-contract";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  OrderRepository,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { OrderNotFound } from "@btravstack/start-example-order-domain";
import { ErrAsync, fromSafePromise } from "unthrown";
import { expect, type TestAPI } from "vitest";

import { orderAmqpRuntime } from "./amqp-runtime.js";
import { OrderAmqpModule } from "./module.js";

type App<E> = RunningApp<E, AmqpInfo>;

/**
 * `X` is pinned to the three ports the composition roots export rather than
 * left generic: `start`'s needs gate is a phantom rest parameter proven at the
 * call site, and no proof is available inside a helper generic in the module's
 * own exports. The runtime needs only two of them.
 */
type AmqpPorts = PlaceOrder | FindOrder | Logger;

/**
 * The kernel options a test may override. Only the drain budget so far — a
 * test that strands a delivery needs the deadline to arrive in milliseconds
 * rather than in the default twenty seconds.
 */
type ServeOptions = { readonly drainTimeoutMs: number };

type Serve = <E>(module: Module<AmqpPorts, E, Scope>, options?: ServeOptions) => Promise<App<E>>;

const persistenceOf = (repository: ServiceOf<OrderRepository>) =>
  Module("StubPersistence")({
    provides: [Provider(OrderRepository)({ value: repository })],
    exports: [OrderRepository],
  });

/**
 * A composition root shaped like the real one but with the repository swapped:
 * same `ApplicationModule`, same runtime, same three exported ports, so the
 * transport under test is unchanged.
 */
const amqpWith = (repository: ServiceOf<OrderRepository>) =>
  Module("StubAmqp")({
    imports: [ApplicationModule, persistenceOf(repository)],
    provides: [],
    exports: [PlaceOrder, FindOrder, Logger],
  });

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach `Logger` the way `Module.scoped` can. This publishes the very `Logger`
 * service instance the use cases write to.
 */
class LoggerTap extends Port("LoggerTap")<{ readonly lines: () => readonly string[] }> {}

const tappedAmqp = () => {
  let read: () => readonly string[] = () => [];

  return {
    module: Module("TappedAmqp")({
      imports: [OrderAmqpModule],
      provides: [
        Provider(LoggerTap)([Logger], {
          sync: (logger) => {
            read = logger.lines;
            return { lines: logger.lines };
          },
        }),
      ],
      exports: [PlaceOrder, FindOrder, Logger],
    }),
    /** The raw lines, unredacted — what proves a delivery's payload arrived intact. */
    lines: (): readonly string[] => read(),
    traces: (): readonly string[] => read().map((line) => line.slice(0, line.indexOf("]") + 1)),
  };
};

/**
 * A composition root whose repository fails in a way nobody modelled: no
 * `qualify` triaged the rejection, so it is a `Defect` — and a defect is what
 * the queue's own retry policy is for. `attempts()` reports how many times the
 * broker redelivered it.
 */
const unmodelledAmqp = () => {
  let attempts = 0;

  return {
    module: amqpWith({
      save: () => {
        attempts += 1;
        return fromSafePromise(Promise.reject(new Error("the database is on fire")));
      },
      find: (id) => ErrAsync(new OrderNotFound({ id })),
    }),
    attempts: (): number => attempts,
  };
};

/**
 * A repository whose `save` never settles until `release()` is called, and
 * whose `arrived` promise reports the moment the delivery reached it. The
 * drain spec turns on knowing a unit is genuinely in flight before the drain
 * starts — polling a wall clock instead would be the flake.
 */
const gatedAmqp = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    module: amqpWith({
      save: (order) => {
        entered();
        return fromSafePromise(held.then(() => order));
      },
      find: (id) => ErrAsync(new OrderNotFound({ id })),
    }),
    arrived,
    release: () => release(),
  };
};

export type AmqpFixtures = {
  /**
   * Boots an app whose AMQP worker consumes the real `order-placements` queue
   * of this test's own vhost, and registers its shutdown. The teardown runs
   * even when the test fails, which is what a `try`/`finally` used to
   * hand-roll — and it keeps the assertion those blocks carried: the app
   * exited `Ok`.
   */
  readonly serve: Serve;
  readonly tapped: ReturnType<typeof tappedAmqp>;
  readonly unmodelled: ReturnType<typeof unmodelledAmqp>;
  readonly gate: ReturnType<typeof gatedAmqp>;
};

// Annotated explicitly: TS2883 otherwise refuses to name the inferred type,
// since `AmqpTestFixtures` reaches back into amqplib's `Channel` /
// `ChannelModel` / `ConsumeMessage` / `Options.Publish`.
export const it: TestAPI<AmqpTestFixtures & AmqpFixtures> = amqpIt.extend<AmqpFixtures>({
  serve: async ({ amqpConnectionUrl }, use) => {
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: Serve = async (module, options) => {
      const app = start(module, {
        runtime: orderAmqpRuntime({ contract: orderContract, urls: [amqpConnectionUrl] }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
        ...options,
      });
      shutdowns.push(async () => {
        app.stop();
        await expect(app.exited).toBeOk();
      });
      // `runtimeInfo()` resolves once the worker is consuming — await it here
      // so the caller's test body never races the worker's own startup.
      await app.runtimeInfo();
      return app;
    };

    await use(serve);

    for (const shutdown of shutdowns) await shutdown();
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tapped: async ({}, use) => {
    await use(tappedAmqp());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  unmodelled: async ({}, use) => {
    await use(unmodelledAmqp());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    const gate = gatedAmqp();
    await use(gate);
    // Released on every exit path, so a delivery a test deliberately stranded
    // cannot outlive the test that stranded it.
    gate.release();
  },
});
