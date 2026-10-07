import type { ConfigInvalid, Env } from "@btravstack/config";
import { type RunningApp, Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Provider, type Scope, type ServiceOf } from "@btravstack/di";
import {
  ShippingService,
  StockService,
  type OrderRepository,
} from "@btravstack/example-order-application";
import {
  OrderNotFound,
  OutOfStock,
  ShippingUnavailable,
  TenantId,
  placeOrder,
  type OrderId,
} from "@btravstack/example-order-domain";
import {
  OrderDatabase,
  OrderPersistenceModule,
  prismaOrderRepository,
} from "@btravstack/example-order-infrastructure";
import { orderContract, type OrderContract } from "@btravstack/example-order-temporal-contract";
import { createNamespace } from "@btravstack/internal-test-infra/namespace";
import { observability, type Line, type Sink } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import {
  memoryStorageBackend,
  storage,
  StorageBackend,
  type StorageService,
} from "@btravstack/storage";
import {
  TemporalModule,
  type TemporalInfo,
  type TemporalUnreachable,
} from "@btravstack/temporal-worker";
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
import { uuidv7 } from "uuidv7";
import { inject, test } from "vitest";

import { ActivityUnitModule } from "../activity-unit.js";
import { BillingModule } from "../billing.js";
import { FulfillmentModule } from "../fulfillment.js";
import { orderActivities } from "../module.js";
import { chargeOrder } from "../slices/billing/activities.js";
import { fulfillOrder } from "../slices/fulfillment/activities.js";
import { sweepStaleOrders } from "../slices/sweep/activities.js";

/**
 * One Temporal server for the whole repository, with a namespace of this spec
 * file's own on it — Temporal's own isolation boundary, and enough here because
 * nothing in this suite advances a clock.
 */
type Server = { readonly address: string; readonly namespace: string };

// The starter's own errors join the app's: a bad environment, or a service
// that will not answer.
type App<E> = RunningApp<E | ConfigInvalid | TemporalUnreachable, TemporalInfo>;

/** One booted deployment: the kernel's handle, a client that can reach it, and the store its saga writes to. */
type Deployment<E> = {
  readonly app: App<E>;
  readonly client: ContractClient<OrderContract>;
  /**
   * The confirmation store this deployment was composed with, so a spec can
   * read back what the saga wrote — the assertion that the last forward step
   * did more than log.
   */
  readonly confirmations: StorageService;
};

/**
 * `X` is pinned rather than left generic: `start`'s gate is proven at the call
 * site, and no proof is available inside a helper generic in the module's own
 * exports. `Logger` is in the union because `serve` composes `BillingModule`
 * beside `module`, and its need for one is invisible past this type otherwise;
 * `OrderDatabase` and `Tracer` are what `ActivityUnitModule` reads once forked.
 */
type Serve = <E>(
  module: Module<
    StockService | ShippingService | Logger | Meter | Tracer | InstanceType<typeof OrderDatabase>,
    E,
    Scope | Env
  >,
) => Promise<Deployment<E>>;

/**
 * Composed deliberately, not `overridden(OrderTemporalWorker, …)`: an override
 * substitutes providers into a FIXED root, and this deployment's SHAPE is what
 * varies — the contract carries a task queue of its own per test and the
 * fulfillment module changes per spec.
 *
 * The application half of that per-test root, with this test's fulfillment
 * module swapped in, so only the external services' answers differ and the lines
 * the saga writes land in `sink`. `Logger` and `Meter` are exported because
 * `serve` composes `BillingModule` as a sibling rather than nesting it;
 * `OrderDatabase` and `Tracer` because the activity fork reads them.
 */
const rootWith = (fulfillment: typeof FulfillmentModule, sink: Sink) =>
  Module("StubTemporal")({
    imports: [OrderPersistenceModule, fulfillment, observability({ sink }), otel()],
    exports: [OrderDatabase, StockService, ShippingService, Logger, Meter, Tracer],
  });

/**
 * `start` hands the application context to the runtime alone, so `tapped` is
 * what captures the very Prisma client the running app uses — and `reader`
 * builds the adapter over it for a tenant, exactly as the activity fork does,
 * which is the only way to read a row back now that the repository is bound
 * per attempt. The tenant is not optional: `Order` carries a row-security
 * policy and the adapter pins it per transaction, so a reader built for no
 * tenant sees nothing at all. The log lines need no tap — `observability({
 * sink })` hands them over as values.
 */
const deployment = (fulfillment: typeof FulfillmentModule) => {
  const lines: Line[] = [];
  const tap = tapped(
    rootWith(fulfillment, (line) => lines.push(line)),
    [OrderDatabase],
  );
  return {
    module: tap.module,
    lines: (): readonly Line[] => lines,
    reader: (tenant: TenantId): ServiceOf<OrderRepository> => {
      const [db] = tap.services();
      return prismaOrderRepository(db, tenant);
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
          inject: {},
          value: {
            reserve: (orderId, quantity) =>
              ErrAsync(new OutOfStock({ id: orderId as OrderId, quantity })),
            release: () => OkAsync(),
          },
        }),
        Provider(ShippingService)({ inject: {}, value: { arrange: () => OkAsync() } }),
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
          inject: {},
          value: {
            reserve: () => OkAsync(),
            release: (orderId) => {
              released.push(orderId);
              return OkAsync();
            },
          },
        }),
        Provider(ShippingService)({
          inject: {},
          value: {
            arrange: (orderId) => ErrAsync(new ShippingUnavailable({ id: orderId as OrderId })),
          },
        }),
      ],
      exports: [StockService, ShippingService],
    }),
  );

  return { ...base, released: (): readonly string[] => released };
};

/**
 * A repository holding two stale orders and recording what it is asked to
 * remove — for the sweep's own logic, which needs no worker to be driven.
 * `list` answers whatever is still held, so a sweep that removes it all is
 * answered an empty page next.
 */
const staleStoreOf = (onFirstList: (replace: (id: string) => void) => void = () => undefined) => {
  const ids = ["0199a1e0-0000-7000-8000-00000000d001", "0199a1e0-0000-7000-8000-00000000d002"];
  const longAgo = new Date("2025-01-01T00:00:00.000Z");
  const rows = new Map(
    ids.map((id) => [id, { order: placeOrder(id, 1).getOrThrow(), placedAt: longAgo }]),
  );
  const tombstones: string[] = [];
  let listed = false;
  const replace = (id: string) => {
    rows.set(id, {
      order: placeOrder(id, 1).getOrThrow(),
      placedAt: new Date(Date.now() + 3_600_000),
    });
  };
  const repository: ServiceOf<OrderRepository> = {
    save: (order) => OkAsync(order),
    find: (id) => ErrAsync(new OrderNotFound({ id: id as OrderId })),
    list: ({ placedBefore }) => {
      const items = [...rows.values()]
        .filter((row) => placedBefore === undefined || row.placedAt < placedBefore)
        .map((row) => row.order);
      if (!listed) {
        listed = true;
        onFirstList(replace);
      }
      return OkAsync({ items, hasPreviousPage: false, hasNextPage: false });
    },
    remove: (id, { placedBefore } = {}) => {
      const row = rows.get(id);
      if (row === undefined || (placedBefore !== undefined && row.placedAt >= placedBefore))
        return ErrAsync(new OrderNotFound({ id: id as OrderId }));
      rows.delete(id);
      tombstones.push(id);
      return OkAsync();
    },
  };
  return {
    repository,
    /** The ids a tombstone was written for — what a removal leaves in the outbox. */
    removed: (): readonly string[] => tombstones,
    held: (): readonly string[] => [...rows.keys()],
  };
};

export type TemporalFixtures = {
  /** Two stale orders in memory, and the ids a sweep removed from them. */
  readonly staleStore: ReturnType<typeof staleStoreOf>;
  /**
   * The same store, where the first stale order is compensated away and its
   * id placed again — freshly — between the sweep's listing and its removal.
   */
  readonly racedStore: ReturnType<typeof staleStoreOf>;
  /** Where the shared server is, and the namespace this spec file owns on it. */
  readonly server: Server;
  /**
   * This test's tenant, and nobody else's. The database is shared by every
   * workspace's run — one migration for the whole gate rather than one per
   * test — so a UUID here is what keeps one test's `0199a1e0-0000-7000-8000-000000000001` from being another's.
   * It rides every workflow's arguments — the contract declares it — which is
   * how it reaches the adapters.
   */
  readonly tenant: TenantId;
  /** `@btravstack/testing`'s boot: every app it starts is stopped when the test ends. */
  readonly boot: Boot;
  /**
   * Boots an app whose Temporal worker polls a task queue of this test's own,
   * through `boot` — so its shutdown is the fixture's, on every exit path.
   */
  readonly serve: Serve;
  /**
   * The schedule ids this file's namespace holds for a tenant. Read through
   * Temporal's visibility store, which is eventually consistent — so a spec
   * waits on it rather than reading it once.
   */
  readonly scheduled: (tenant: TenantId) => Promise<readonly string[]>;
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
    await use(TenantId(uuidv7()));
  },

  serve: async ({ server, boot }, use) => {
    // Memoised per spec file by `bundleFor`: webpack over the workflow module
    // is the single most expensive thing in this suite, and every test needs
    // the same bundle.
    const workflowBundle = await bundleFor(
      // `fixturePath` appends the CALLER's extension, so it needs this file's
      // own URL; the hop up out of `__tests__/` rides the name instead.
      fixturePath(import.meta.url, "../workflows"),
    );

    // Closed in this fixture's own teardown, so a test that fails mid-body
    // still leaves no connection behind on the shared server.
    const connections: Connection[] = [];

    const serve: Serve = async (module) => {
      // A queue of this test's own: the namespace is shared by every test in
      // this file, and two workers polling one queue would race for each
      // other's tasks.
      const contract = withTaskQueue(orderContract, nextTaskQueueId("orders"));

      // The same `TemporalModule` sugar `OrderTemporalWorker` is, built from
      // what only this test knows. `BillingModule` sits beside `module` rather
      // than inside it, since no spec swaps it, and the two pieces are in
      // `provides` because `orderActivities`'s `deps` are their PORTS.
      // The store the saga writes its confirmation to: in memory, and handed to
      // the test as a service so a spec can read the document back. The real
      // root composes `s3Storage()`; the S3 adapter is proved in
      // `packages/storage`, and what this suite is about is that the saga WRITES.
      const confirmations = memoryStorageBackend();
      const worker = TemporalModule("StubTemporalWorker")({
        contract,
        activities: orderActivities,
        unit: { activity: ActivityUnitModule },
        workflows: { workflowBundle },
        imports: [
          module,
          BillingModule,
          storage({
            adapter: Module("FixtureStorage")({
              provides: [Provider(StorageBackend)({ inject: {}, value: confirmations })],
              exports: [StorageBackend],
            }),
          }),
        ],
        provides: [fulfillOrder, chargeOrder, sweepStaleOrders],
      });

      const app = boot(worker, {
        env: {
          TEMPORAL_ADDRESS: server.address,
          TEMPORAL_NAMESPACE: server.namespace,
          DATABASE_URL: inject("__ORDERS_DATABASE_URL__"),
          // otel() rides the root; a spec run stands up no collector, so the
          // SDK is disabled through its own switch — the ports still resolve.
          OTEL_SDK_DISABLED: "true",
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

      return { app, client, confirmations };
    };

    await use(serve);
    for (const connection of connections) await connection.close();
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  staleStore: async ({}, use) => {
    await use(staleStoreOf());
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  racedStore: async ({}, use) => {
    await use(staleStoreOf((replace) => replace("0199a1e0-0000-7000-8000-00000000d001")));
  },

  scheduled: async ({ server }, use) => {
    const connection = await Connection.connect({ address: server.address });
    const client = new Client({ connection, namespace: server.namespace });
    await use(async (tenant) => {
      const ids: string[] = [];
      for await (const schedule of client.schedule.list())
        if (schedule.scheduleId.includes(tenant)) ids.push(schedule.scheduleId);
      return ids;
    });
    await connection.close();
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
