import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import { start, type RunningApp } from "@btravstack/start";
import {
  ApplicationModule,
  FindOrder,
  Logger,
  OrderRepository,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { OrderNotFound } from "@btravstack/start-example-order-domain";
import { ErrAsync, fromSafePromise, type AsyncResult } from "unthrown";
import { expect, test } from "vitest";

import { OrderWorkerModule } from "./module.js";
import { queueWorkerRuntime, type OrderWorkerInfo } from "./queue-runtime.js";
import { createOrderQueue, type OrderQueue, type PlaceOrderJob, type Settlement } from "./queue.js";

type App<E> = RunningApp<E, OrderWorkerInfo>;

/**
 * `X` is pinned to the three ports the composition roots export rather than
 * left generic: `start`'s needs gate is a phantom rest parameter proven at the
 * call site, and no proof is available inside a helper generic in the module's
 * own exports. The runtime needs only two of them.
 */
type WorkerPorts = PlaceOrder | FindOrder | Logger;

type Serve = <E>(module: Module<WorkerPorts, E, Scope>) => App<E>;

/** A message id that is deliberately not the order id — see `PlaceOrderJob`. */
const jobOf = (id: string, orderId: string, quantity: number): PlaceOrderJob => ({
  id,
  orderId,
  quantity,
});

/**
 * Reports whether a publish settled within one macrotask turn.
 *
 * `publish` only resolves when a running worker settles the job, so awaiting
 * one that nobody will claim hangs the test until Vitest's timeout — a broken
 * suite where the fact under test is a legitimate state. The turn boundary is
 * a bound rather than a guess: the delivery path is microtasks end to end, with
 * no timer anywhere in it, so anything a serving worker was going to settle has
 * settled by the time the immediate fires.
 */
const settledWithinATurn = (
  published: AsyncResult<Settlement, never>,
): Promise<"settled" | "unsettled"> =>
  Promise.race([
    published.match({
      ok: () => "settled" as const,
      errCases: (matcher) => matcher,
      defect: () => "settled" as const,
    }),
    new Promise<"unsettled">((resolve) => {
      setImmediate(() => resolve("unsettled"));
    }),
  ]);

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
const workerWith = (repository: ServiceOf<OrderRepository>) =>
  Module("StubWorker")({
    imports: [ApplicationModule, persistenceOf(repository)],
    exports: [PlaceOrder, FindOrder, Logger],
  });

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach `Logger` the way `Module.scoped` can. This publishes the very `Logger`
 * service instance the use cases and the disposition write to.
 */
class LoggerTap extends Port("LoggerTap")<{ readonly lines: () => readonly string[] }> {}

const tappedWorker = () => {
  let read: () => readonly string[] = () => [];

  return {
    worker: Module("TappedWorker")({
      imports: [OrderWorkerModule],
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
    traces: (): readonly string[] => read().map((line) => line.slice(0, line.indexOf("]") + 1)),
  };
};

/**
 * A composition root whose repository fails in a way nobody modelled: no
 * `qualify` triaged the rejection, so it is a defect — and a defect is what the
 * worker retries.
 */
const unmodelledWorker = () =>
  workerWith({
    save: () => fromSafePromise(Promise.reject(new Error("the database is on fire"))),
    find: (id) => ErrAsync(new OrderNotFound({ id })),
  });

/**
 * A repository whose `save` never settles until `release()` is called, and
 * whose `arrived` promise reports the moment the job reached it. The drain spec
 * turns on knowing a unit is genuinely in flight before the drain starts —
 * polling a wall clock instead would be the flake.
 */
const gatedWorker = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    worker: workerWith({
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

export type WorkerFixtures = {
  /**
   * The very queue the runtime consumes, so a spec is the producer half.
   *
   * A publish is awaited only under a `serve`d worker — that is the
   * precondition `OrderQueue.publish` documents, and `settledWithinATurn` is
   * how the two specs that go without one stay a failure instead of a hang.
   */
  readonly queue: OrderQueue;
  /**
   * Starts an app on that queue and registers its shutdown. The teardown runs
   * even when the test fails, which is what a `try`/`finally` used to
   * hand-roll — and it keeps the assertion those blocks carried: the app
   * exited `Ok`.
   */
  readonly serve: Serve;
  readonly aJob: typeof jobOf;
  /** Races a publish against one macrotask turn — see `settledWithinATurn`. */
  readonly withinATurn: typeof settledWithinATurn;
  readonly unmodelled: ReturnType<typeof unmodelledWorker>;
  readonly gate: ReturnType<typeof gatedWorker>;
  readonly tapped: ReturnType<typeof tappedWorker>;
};

export const it = test.extend<WorkerFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  queue: async ({}, use) => {
    await use(createOrderQueue());
  },

  serve: async ({ queue }, use) => {
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: Serve = (module) => {
      const app = start(module, {
        runtime: queueWorkerRuntime({ queue }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
      });
      shutdowns.push(async () => {
        app.stop();
        await expect(app.exited).toBeOk();
      });
      return app;
    };

    await use(serve);

    for (const shutdown of shutdowns) await shutdown();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  aJob: async ({}, use) => {
    await use(jobOf);
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  withinATurn: async ({}, use) => {
    await use(settledWithinATurn);
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  unmodelled: async ({}, use) => {
    await use(unmodelledWorker());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    await use(gatedWorker());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  tapped: async ({}, use) => {
    await use(tappedWorker());
  },
});
