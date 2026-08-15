import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { start, type ConfigInvalid, type RunningApp } from "@btravstack/core";
import { Module, Port, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { OutOfStock, ShippingUnavailable } from "@btravstack/example-order-domain";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract, type OrderContract } from "@btravstack/example-order-temporal-contract";
import type { TemporalInfo } from "@btravstack/temporal";
import { TypedClient, type ContractClient } from "@temporal-contract/client";
import { createTimeSkippingTest } from "@temporal-contract/testing/time-skipping";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { ErrAsync, OkAsync } from "unthrown";
import { expect } from "vitest";

import { FulfillmentModule } from "./fulfillment.js";
import {
  OrderTemporalRuntime,
  temporalModule,
  type TemporalUnreachable,
} from "./temporal-runtime.js";

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

// The runtime module's own errors join the app's: a bad environment, or a
// service that will not answer.
type App<E> = RunningApp<E | ConfigInvalid | TemporalUnreachable, TemporalInfo>;

/**
 * `X` is pinned to the five ports the composition root exports rather than
 * left generic: `start`'s needs gate is a phantom rest parameter proven at the
 * call site, and no proof is available inside a helper generic in the module's
 * own exports.
 */
type TemporalPorts = PlaceOrder | OrderRepository | StockService | ShippingService | Logger;

/** One booted deployment: the kernel's handle, and a client that can reach it. */
type Deployment<E> = {
  readonly app: App<E>;
  readonly client: ContractClient<OrderContract>;
};

type Serve = <E>(module: Module<TemporalPorts, E, Scope>) => Promise<Deployment<E>>;

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach the services the way `Module.scoped` can. This captures the very
 * instances the running app uses — the repository the compensation assertions
 * read through, and the logger the stub services write to.
 */
class ServicesTap extends Port("ServicesTap")<{
  readonly repository: ServiceOf<OrderRepository>;
  readonly logger: ServiceOf<Logger>;
}> {}

const tapProvider = (capture: (services: ServiceOf<ServicesTap>) => void) =>
  Provider(ServicesTap)([OrderRepository, Logger], {
    sync: (repository, logger) => {
      const services = { repository, logger };
      capture(services);
      return services;
    },
  });

/**
 * A composition root shaped like the real one, with this test's fulfillment
 * module swapped in: same `ApplicationModule`, same `PersistenceModule`, same
 * five exported ports, so the orchestration under test is unchanged and only
 * the external services' answers differ. The runtime joins in `serve`, which
 * is where the per-test queue and the environment's connection are known.
 */
const rootWith = (
  fulfillment: typeof FulfillmentModule,
  capture: (services: ServiceOf<ServicesTap>) => void,
) =>
  Module("StubTemporal")({
    imports: [ApplicationModule, PersistenceModule, fulfillment],
    provides: [tapProvider(capture)],
    exports: [PlaceOrder, OrderRepository, StockService, ShippingService, Logger],
  });

const deployment = (fulfillment: typeof FulfillmentModule) => {
  let services: ServiceOf<ServicesTap> | undefined;

  return {
    module: rootWith(fulfillment, (captured) => {
      services = captured;
    }),
    services: (): ServiceOf<ServicesTap> => {
      // oxlint-disable-next-line unthrown/no-throw -- a fixture misused before `serve` is a broken test, and the loudest possible answer is the right one
      if (services === undefined) throw new Error("the app has not been served yet");
      return services;
    },
  };
};

/** The real thing: the same fulfillment module `main.ts` boots. */
const fulfillingTemporal = () => deployment(FulfillmentModule);

/** Stock says a permanent no; everything else is the real composition. */
const outOfStockTemporal = () =>
  deployment(
    Module("Fulfillment")({
      provides: [
        Provider(StockService)({
          value: {
            reserve: (orderId, quantity) => ErrAsync(new OutOfStock({ id: orderId, quantity })),
            release: () => OkAsync(),
          },
        }),
        Provider(ShippingService)({
          value: { arrange: () => OkAsync() },
        }),
      ],
      exports: [StockService, ShippingService],
    }),
  );

/**
 * Shipping says a permanent no, and the stock stub records what the saga asks
 * of it — `released()` is the walk-back's witness.
 */
const noShippingTemporal = () => {
  const released: string[] = [];

  const base = deployment(
    Module("Fulfillment")({
      provides: [
        Provider(StockService)({
          value: {
            reserve: () => OkAsync(),
            release: (orderId) => {
              released.push(orderId);
              return OkAsync();
            },
          },
        }),
        Provider(ShippingService)({
          value: { arrange: (orderId) => ErrAsync(new ShippingUnavailable({ id: orderId })) },
        }),
      ],
      exports: [StockService, ShippingService],
    }),
  );

  return { ...base, released: (): readonly string[] => released };
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
  readonly fulfilling: ReturnType<typeof fulfillingTemporal>;
  readonly outOfStock: ReturnType<typeof outOfStockTemporal>;
  readonly noShipping: ReturnType<typeof noShippingTemporal>;
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

      // The runtime joins the graph the way `OrderTemporalWorker` adds it —
      // built from what only this test knows: its queue and the memoised
      // bundle. The connection is the module's own resource, opened against
      // the environment's address per test and closed with the scope; the
      // shared `testEnv.nativeConnection` is never handed over, so no test can
      // close it under the next.
      const worker = Module("StubTemporalWorker")({
        imports: [module, temporalModule({ contract, workflows: { workflowBundle } })],
        exports: [
          OrderTemporalRuntime,
          PlaceOrder,
          OrderRepository,
          StockService,
          ShippingService,
          Logger,
        ],
      });

      const app = start(worker, {
        env: { TEMPORAL_ADDRESS: testEnv.address },
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
  fulfilling: async ({}, use) => {
    await use(fulfillingTemporal());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  outOfStock: async ({}, use) => {
    await use(outOfStockTemporal());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  noShipping: async ({}, use) => {
    await use(noShippingTemporal());
  },
});
