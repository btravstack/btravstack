import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
import {
  orderContract,
  type OrderContract,
} from "@btravstack/start-example-order-temporal-contract";
import { TypedClient, type ContractClient } from "@temporal-contract/client";
import { createTimeSkippingTest } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ErrAsync, fromSafePromise } from "unthrown";
import { expect } from "vitest";

import { OrderTemporalModule } from "./module.js";
import { temporalWorkerRuntime, type OrderTemporalInfo } from "./temporal-runtime.js";

/**
 * The time-skipping server binary, cached where **we** decide rather than in the
 * OS temp directory.
 *
 * `@temporalio/testing` downloads a 64 MB test server keyed by the SDK version,
 * and its two defaults are both wrong for a repository gate: the system temp
 * directory (which CI wipes between jobs and macOS purges on its own schedule)
 * and a `ttl` of one day (so a developer who runs the suite on Monday and again
 * on Wednesday downloads it twice). A repo-local, gitignored path with a
 * year-long ttl makes the download a once-ever event locally and a cacheable
 * path in CI. `temporal-contract` forwards these options through unchanged.
 *
 * This is the one example in the repository that needs network access on a cold
 * cache — see the README.
 */
const downloadDir = fileURLToPath(
  new URL("../../../.cache/temporal-test-server/", import.meta.url),
);

// The Rust ephemeral-server downloader writes into this path; creating it here
// keeps the fixture's failure mode "no network" rather than "no directory".
mkdirSync(downloadDir, { recursive: true });

type App<E> = RunningApp<E, OrderTemporalInfo>;

/**
 * `X` is pinned to the three ports the composition roots export rather than
 * left generic: `start`'s needs gate is a phantom rest parameter proven at the
 * call site, and no proof is available inside a helper generic in the module's
 * own exports. The runtime needs only two of them.
 */
type TemporalPorts = PlaceOrder | FindOrder | Logger;

/** One booted deployment: the kernel's handle, and a client that can reach it. */
type Deployment<E> = {
  readonly app: App<E>;
  readonly client: ContractClient<OrderContract>;
};

type Serve = <E>(module: Module<TemporalPorts, E, Scope>) => Promise<Deployment<E>>;

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
const temporalWith = (repository: ServiceOf<OrderRepository>) =>
  Module("StubTemporal")({
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

const tappedTemporal = () => {
  let read: () => readonly string[] = () => [];

  return {
    module: Module("TappedTemporal")({
      imports: [OrderTemporalModule],
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
 * `qualify` triaged the rejection, so it is a defect — and a defect is what
 * Temporal's own retry policy is for. `attempts()` reports how many times the
 * platform came back.
 */
const unmodelledTemporal = () => {
  let attempts = 0;

  return {
    module: temporalWith({
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
 * A repository whose `save` never settles until `release()` is called, and whose
 * `arrived` promise reports the moment the activity reached it. The drain spec
 * turns on knowing a unit is genuinely in flight before the drain starts —
 * polling a wall clock instead would be the flake.
 */
const gatedTemporal = () => {
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    module: temporalWith({
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

export type TemporalFixtures = {
  readonly testEnv: TestWorkflowEnvironment;
  /**
   * Boots an app whose Temporal worker polls a task queue of this test's own,
   * and registers its shutdown. The teardown runs even when the test fails,
   * which is what a `try`/`finally` used to hand-roll — and it keeps the
   * assertion those blocks carried: the app exited `Ok`.
   */
  readonly serve: Serve;
  readonly tapped: ReturnType<typeof tappedTemporal>;
  readonly unmodelled: ReturnType<typeof unmodelledTemporal>;
  readonly gate: ReturnType<typeof gatedTemporal>;
};

export const it = createTimeSkippingTest({
  server: { executable: { type: "cached-download", downloadDir, ttl: "365d" } },
}).extend<Omit<TemporalFixtures, "testEnv">>({
  serve: async ({ testEnv }, use) => {
    // Memoised per spec file by `bundleFor`: webpack over the workflow module
    // is the single most expensive thing in this suite, and every test needs
    // the same bundle.
    const workflowBundle = await bundleFor(fixturePath(import.meta.url, "workflows"));
    const shutdowns: (() => Promise<void>)[] = [];

    const serve: Serve = async (module) => {
      // A queue of this test's own: the environment is shared by every test in
      // the worker process, and two workers polling one queue would race for
      // each other's tasks.
      const contract = withTaskQueue(orderContract, nextTaskQueueId("orders"));

      const app = start(module, {
        runtime: temporalWorkerRuntime({
          contract,
          connection: testEnv.nativeConnection,
          workflows: { workflowBundle },
        }),
        signals: false,
        probes: false,
        preDrainDelayMs: 0,
      });

      shutdowns.push(async () => {
        app.stop();
        await expect(app.exited).toBeOk();
      });

      // `.get()`, not `.getOrThrow()`: the error channel is empty, so a client
      // that could not be built is a defect and rethrowing its cause is what
      // should fail the test.
      const client = (await TypedClient.create({ client: testEnv.client }).get()).for(contract);

      return { app, client };
    };

    await use(serve);

    for (const shutdown of shutdowns) await shutdown();
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tapped: async ({}, use) => {
    await use(tappedTemporal());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  unmodelled: async ({}, use) => {
    await use(unmodelledTemporal());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  gate: async ({}, use) => {
    await use(gatedTemporal());
  },
});
