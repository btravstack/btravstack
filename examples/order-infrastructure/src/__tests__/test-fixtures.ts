import { Env } from "@btravstack/config";
import type { ConfigInvalid } from "@btravstack/config";
import { Module, Provider, type ServiceOf } from "@btravstack/di";
import type { CustomerRepository, OrderRepository } from "@btravstack/example-order-application";
import { TenantId, placeOrder, type Order } from "@btravstack/example-order-domain";
import type { OutboxStoreService } from "@btravstack/outbox";
import { prismaOutboxStore } from "@btravstack/outbox/prisma";
import { prismaDatabase, type DatabaseUnreachable } from "@btravstack/prisma";
import postgres from "@prisma/orm-postgres/runtime";
import type { AsyncResult } from "unthrown";
import { uuidv7 } from "uuidv7";
import { inject, test } from "vitest";

import {
  openDatabase,
  prismaCustomerRepository,
  prismaOrderRepository,
  decodeOrderPayload,
  type OrderDatabaseClient,
  type OrderPayload,
} from "../index.js";
import type { Contract } from "../prisma/contract.js";
import contractJson from "../prisma/contract.json" with { type: "json" };

export type PersistenceFixtures = {
  /**
   * A client on the shared PostgreSQL database, already migrated by
   * `src/global-setup.ts`. It is the SAME database every other test in the
   * repository uses — nothing is created, truncated or dropped per test,
   * because nothing needs to be: `tenant` is what separates them.
   */
  readonly db: OrderDatabaseClient;
  /**
   * The same client, named for what the row-security specs use it as: the
   * application role connecting with nothing pinned. Every statement through
   * it reaches `Order`'s policy with `current_setting('app.tenant_id', true)`
   * unset.
   */
  readonly raw: OrderDatabaseClient;
  /**
   * This test's tenant, and nobody else's. A UUID, so it is unique across
   * spec files and across the workspaces running concurrently — which is the
   * whole trick: a shared database costs one migration for the run instead of
   * one per test, and isolation comes from the tenant column rather than from
   * a database nobody else can see.
   *
   * The repository below is BUILT for it, the way a unit builds one, so no
   * call names a tenant and none can name another's.
   */
  readonly tenant: TenantId;
  /** A second tenant on the same database, for the specs that assert across the boundary. */
  readonly otherTenant: TenantId;
  readonly repository: ServiceOf<OrderRepository>;
  /** The same adapter bound to `otherTenant`, so a cross-tenant spec writes through a real one. */
  readonly otherRepository: ServiceOf<OrderRepository>;
  readonly customers: ServiceOf<CustomerRepository>;
  /** `@btravstack/outbox`'s store over this application's own table — what the relay claims from. */
  readonly outbox: OutboxStoreService;
  /** An outbox row's payload as `prismaOrderRepository` encoded it. */
  readonly decoded: (payload: string | null) => OrderPayload;
  /**
   * The same store over a pool whose every session the server ends after
   * 200 ms idle inside a transaction — the setting that, unlifted, frees a
   * claim's lock while its publisher is still working.
   */
  readonly impatientOutbox: OutboxStoreService;
  /**
   * The same store over a pool of its own, and a way to end every session that
   * pool holds — the database losing a claiming session mid-batch.
   */
  readonly severable: {
    readonly outbox: OutboxStoreService;
    readonly sever: () => Promise<void>;
  };
  readonly anOrder: (id: string, quantity: number) => Order;
  /**
   * Puts a customer in this test's tenant. Straight through the client, past
   * the port, because the port is read-only by design: this application
   * registers nobody, so a row written by something else is exactly what it
   * reads.
   */
  readonly aCustomer: (id: string, name: string) => Promise<void>;
  /** A scope `prismaDatabase` just opened, whose pool gives up on a connection after 2 s, not 20. */
  readonly freshScope: <A>(
    work: (db: OrderDatabaseClient) => AsyncResult<A, never>,
  ) => AsyncResult<A, ConfigInvalid | DatabaseUnreachable>;
};

export const it = test.extend<PersistenceFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  db: async ({}, use) => {
    // `.get()` compiles only on a `Result<T, never>`, which is exactly what
    // `openDatabase` returns — and it panics on a Defect, which is what a test
    // wants from a database that would not open.
    const db = (await openDatabase(inject("__ORDERS_DATABASE_URL__"))).get();
    await use(db);
    await db.runtime().close();
  },

  raw: async ({ db }, use) => {
    await use(db);
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  tenant: async ({}, use) => {
    await use(TenantId(uuidv7()));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  otherTenant: async ({}, use) => {
    await use(TenantId(uuidv7()));
  },

  repository: async ({ db, tenant }, use) => {
    await use(prismaOrderRepository(db, tenant));
  },

  otherRepository: async ({ db, otherTenant }, use) => {
    await use(prismaOrderRepository(db, otherTenant));
  },

  customers: async ({ db }, use) => {
    await use(prismaCustomerRepository(db));
  },

  outbox: async ({ db }, use) => {
    await use(prismaOutboxStore(db, { schema: "orders" }));
  },

  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  decoded: async ({}, use) => {
    await use(decodeOrderPayload);
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  impatientOutbox: async ({}, use) => {
    // libpq's `options` sets the timeout on every session this pool opens,
    // which is the configuration a deployment's role or database carries.
    const url = new URL(inject("__ORDERS_DATABASE_URL__"));
    url.searchParams.set("options", "-c idle_in_transaction_session_timeout=200");
    const db = (await openDatabase(url.toString())).get();
    // Outside a transaction: a fresh client verifies its contract marker on first use, over
    // a second connection, and a claim paying for that idles past the timeout before its lift.
    await db.runtime().query(db.raw.sql`SELECT 1 AS one`.returnsRow({ one: "pg/int4@1" }).build());
    await use(prismaOutboxStore(db, { schema: "orders" }));
    await db.runtime().close();
  },

  severable: async ({ db }, use) => {
    // Named so the spec can find its sessions: a role may end its own backends.
    const name = `severable-${uuidv7()}`;
    const url = new URL(inject("__ORDERS_DATABASE_URL__"));
    url.searchParams.set("application_name", name);
    const own = (await openDatabase(url.toString())).get();
    await own
      .runtime()
      .query(own.raw.sql`SELECT 1 AS one`.returnsRow({ one: "pg/int4@1" }).build());
    await use({
      outbox: prismaOutboxStore(own, { schema: "orders" }),
      sever: async () => {
        await db
          .runtime()
          .query(
            db.raw
              .sql`SELECT count(pg_terminate_backend(pid))::text AS ended FROM pg_stat_activity WHERE application_name = ${name}`
              .returnsRow({ ended: "pg/text@1" })
              .build(),
          );
      },
    });
    await own.runtime().close();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  anOrder: async ({}, use) => {
    await use((id, quantity) => placeOrder(id, quantity).getOrThrow());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  freshScope: async ({}, use) => {
    const database = prismaDatabase("FreshDatabase")({
      client: ({ url, middleware }) =>
        postgres<Contract>({
          contractJson,
          url,
          middleware: middleware as never,
          poolOptions: { connectionTimeoutMillis: 2_000 },
        }),
    });
    const root = Module("FreshScope")({
      imports: [database],
      provides: [
        Provider(Env)({ inject: {}, value: { DATABASE_URL: inject("__ORDERS_DATABASE_URL__") } }),
      ],
      exports: [database.port],
    });
    await use((work) => Module.scoped(root, (ctx) => work(ctx.get(database.port))));
  },

  aCustomer: async ({ db, tenant }, use) => {
    await use(async (id, name) => {
      await db.orm.orders.Customer.create({ tenantId: tenant, customerId: id, name });
    });
  },
});
