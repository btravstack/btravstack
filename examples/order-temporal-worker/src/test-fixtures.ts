import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { ConfigInvalid, Env } from "@btravstack/config";
import type { RunningApp } from "@btravstack/core";
import { Module, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import {
  OrderApplicationModule,
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { OutOfStock, ShippingUnavailable } from "@btravstack/example-order-domain";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { orderContract, type OrderContract } from "@btravstack/example-order-temporal-contract";
import { Logger, observability, type Line, type Sink } from "@btravstack/observability";
import { TemporalModule, type TemporalInfo, type TemporalUnreachable } from "@btravstack/temporal";
import { bootFixture, tapped, type Boot } from "@btravstack/testing";
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

import { BillingModule } from "./billing.js";
import { FulfillmentModule } from "./fulfillment.js";
import { orderActivities } from "./module.js";
import { chargeOrder } from "./slices/billing/activities.js";
import { fulfillOrder } from "./slices/fulfillment/activities.js";

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

// The starter's own errors join the app's: a bad environment, or a service
// that will not answer.
type App<E> = RunningApp<E | ConfigInvalid | TemporalUnreachable, TemporalInfo>;

/** One booted deployment: the kernel's handle, and a client that can reach it. */
type Deployment<E> = {
  readonly app: App<E>;
  readonly client: ContractClient<OrderContract>;
};

/**
 * `X` is pinned to the four ports the activities provider depends on, plus
 * `Logger` — rather than left generic: `start`'s gate is a phantom rest
 * parameter proven at the call site, and no proof is available inside a
 * helper generic in the module's own exports. `Logger` has to be in the union
 * because `serve` composes `BillingModule` beside `module` (see below), and
 * `BillingModule`'s own need for it is invisible past this type unless it is
 * named here too.
 */
type Serve = <E>(
  module: Module<
    PlaceOrder | OrderRepository | StockService | ShippingService | Logger,
    E,
    Scope | Env
  >,
) => Promise<Deployment<E>>;

/**
 * The application half of a root shaped like the real one, with this test's
 * fulfillment module swapped in: same `OrderApplicationModule`, same
 * `OrderPersistenceModule`, same `observability()` — so the orchestration under
 * test is unchanged and only the external services' answers differ, and the
 * lines the saga writes land in `sink` instead of the runner's stdout. It
 * exports what `orderActivities` closes over; the sugar joins in `serve`,
 * which is where the per-test queue and the memoised bundle are known.
 *
 * `Logger` is exported too: `serve` composes `BillingModule` as a sibling of
 * this module rather than nesting it inside, so `BillingModule`'s own need
 * for `Logger` has to be met from here — the one `observability({ sink })` in
 * this graph, so billing's stand-in writes to the same sink the saga's does.
 */
const rootWith = (fulfillment: typeof FulfillmentModule, sink: Sink) =>
  Module("StubTemporal")({
    imports: [OrderApplicationModule, OrderPersistenceModule, fulfillment, observability({ sink })],
    exports: [PlaceOrder, OrderRepository, StockService, ShippingService, Logger],
  });

/**
 * `start` hands the application context to the runtime alone, so a spec cannot
 * reach the services the way `Module.scoped` can. `@btravstack/testing`'s
 * `tapped` captures the very repository instance the running app uses, which
 * the compensation assertions read through; the log lines need no tap at all —
 * `observability({ sink })` hands them over as values.
 */
const deployment = (fulfillment: typeof FulfillmentModule) => {
  const lines: Line[] = [];
  const tap = tapped(
    rootWith(fulfillment, (line) => lines.push(line)),
    [OrderRepository],
  );
  return {
    module: tap.module,
    lines: (): readonly Line[] => lines,
    services: (): { readonly repository: ServiceOf<OrderRepository> } => {
      const [repository] = tap.services();
      return { repository };
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
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * Boots an app whose Temporal worker polls a task queue of this test's own,
   * through `boot` — so its shutdown is the fixture's, on every exit path.
   */
  readonly serve: Serve;
  readonly fulfilling: ReturnType<typeof fulfillingTemporal>;
  readonly outOfStock: ReturnType<typeof outOfStockTemporal>;
  readonly noShipping: ReturnType<typeof noShippingTemporal>;
};

export const it = createTimeSkippingTest({
  server: { executable: { type: "cached-download", downloadDir, ttl: "365d" } },
}).extend<Omit<TemporalFixtures, "testEnv">>({
  boot: bootFixture(),
  serve: async ({ testEnv, boot }, use) => {
    // Memoised per spec file by `bundleFor`: webpack over the workflow module
    // is the single most expensive thing in this suite, and every test needs
    // the same bundle.
    const workflowBundle = await bundleFor(fixturePath(import.meta.url, "workflows"));

    const serve: Serve = async (module) => {
      // A queue of this test's own: the environment is shared by every test in
      // the worker process, and two workers polling one queue would race for
      // each other's tasks.
      const contract = withTaskQueue(orderContract, nextTaskQueueId("orders"));

      // The same `TemporalModule` sugar `OrderTemporalWorker` is — built from
      // what only this test knows: its queue and the memoised bundle. The
      // connection is the starter's own resource, opened against the
      // environment's address per test and closed with the scope; the shared
      // `testEnv.nativeConnection` is never handed over, so no test can close
      // it under the next.
      //
      // `BillingModule` sits beside `module` rather than inside it: billing is
      // never swapped by a spec, so it is a sibling import the same way
      // `OrderTemporalWorker`'s own root lists `BillingSlice` beside
      // `FulfillmentSlice`. `fulfillOrder` and `chargeOrder` are in `provides`
      // for the reason `module.ts`'s own TSDoc gives — the composed
      // `orderActivities`'s `deps` are the two pieces' PORTS, and nothing
      // discharges them unless something in this tree does.
      const worker = TemporalModule("StubTemporalWorker")({
        contract,
        activities: orderActivities,
        workflows: { workflowBundle },
        imports: [module, BillingModule],
        provides: [fulfillOrder, chargeOrder],
      });

      const app = boot(worker, { env: { TEMPORAL_ADDRESS: testEnv.address } });

      // `.get()`, not `.getOrThrow()`: the error channel is empty, so a client
      // that could not be built is a defect and rethrowing its cause is what
      // should fail the test.
      const client = (await TypedClient.create({ client: testEnv.client }).get()).for(contract);

      return { app, client };
    };

    await use(serve);
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
