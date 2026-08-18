import { randomUUID } from "node:crypto";

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
import { createNamespace } from "@btravstack/internal-test-infra/namespace";
import { Logger, observability, type Line, type Sink } from "@btravstack/observability";
import { TemporalModule, type TemporalInfo, type TemporalUnreachable } from "@btravstack/temporal";
import { bootFixture, tapped, type Boot } from "@btravstack/testing";
import { TypedClient, type ContractClient } from "@temporal-contract/client";
import {
  bundleFor,
  fixturePath,
  nextTaskQueueId,
  withTaskQueue,
} from "@temporal-contract/testing/workflow-bundle";
import { Client, Connection } from "@temporalio/client";
import { ErrAsync, OkAsync } from "unthrown";
import { inject, test } from "vitest";

import { BillingModule } from "./billing.js";
import { FulfillmentModule } from "./fulfillment.js";
import { orderActivities } from "./module.js";
import { chargeOrder } from "./slices/billing/activities.js";
import { fulfillOrder } from "./slices/fulfillment/activities.js";

/**
 * One Temporal server for the whole repository — see `internal/test-infra` —
 * and a namespace of this spec file's own on it. That replaces the 64 MB
 * time-skipping test server this example used to download and start per vitest
 * worker: a namespace is Temporal's own isolation boundary, and nothing here
 * ever advanced a clock, so the skippable one bought nothing a shared server
 * plus a private namespace does not. The example no longer needs the network
 * on a cold cache; it needs a Docker daemon, like the AMQP one.
 */
type Server = { readonly address: string; readonly namespace: string };

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
  /** Where the shared server is, and the namespace this spec file owns on it. */
  readonly server: Server;
  /**
   * This test's tenant, and nobody else's. The database is shared by every
   * workspace's run — one migration for the whole gate rather than one per
   * test — so a UUID here is what keeps one test's `o-1` from being another's.
   * It rides every workflow's arguments — the contract declares it — which is
   * how it reaches the adapters.
   */
  readonly tenant: string;
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

export const it = test.extend<TemporalFixtures>({
  server: [
    // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
    async ({}, use) => {
      const address = `${inject("__TESTCONTAINERS_TEMPORAL_IP__")}:${inject("__TESTCONTAINERS_TEMPORAL_PORT_7233__")}`;
      await use({ address, namespace: await createNamespace(address, "order-worker") });
    },
    // Per FILE, not per test: registering a namespace costs a registry refresh
    // on every Temporal service, while the per-test task queue below is what
    // separates the tests inside one file.
    { scope: "file" },
  ],
  boot: bootFixture(),

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  tenant: async ({}, use) => {
    await use(`t-${randomUUID()}`);
  },

  serve: async ({ server, boot }, use) => {
    // Memoised per spec file by `bundleFor`: webpack over the workflow module
    // is the single most expensive thing in this suite, and every test needs
    // the same bundle.
    const workflowBundle = await bundleFor(fixturePath(import.meta.url, "workflows"));

    // Closed in this fixture's own teardown, so a test that fails mid-body
    // still leaves no connection behind on the shared server.
    const connections: Connection[] = [];

    const serve: Serve = async (module) => {
      // A queue of this test's own: the namespace is shared by every test in
      // this file, and two workers polling one queue would race for each
      // other's tasks.
      const contract = withTaskQueue(orderContract, nextTaskQueueId("orders"));

      // The same `TemporalModule` sugar `OrderTemporalWorker` is — built from
      // what only this test knows: its queue and the memoised bundle. The
      // connection is the starter's own resource, opened against the shared
      // server per test and closed with the scope, so no test can close one
      // under the next.
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

      const app = boot(worker, {
        env: {
          TEMPORAL_ADDRESS: server.address,
          TEMPORAL_NAMESPACE: server.namespace,
          DATABASE_URL: inject("__ORDERS_DATABASE_URL__"),
        },
      });

      // A connection of this test's own, on this file's namespace — the
      // server is shared and nothing may close another test's connection.
      const connection = await Connection.connect({ address: server.address });
      connections.push(connection);
      // `.get()`, not `.getOrThrow()`: the error channel is empty, so a client
      // that could not be built is a defect and rethrowing its cause is what
      // should fail the test.
      const client = (
        await TypedClient.create({
          client: new Client({ connection, namespace: server.namespace }),
        }).get()
      ).for(contract);

      return { app, client };
    };

    await use(serve);
    for (const connection of connections) await connection.close();
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
