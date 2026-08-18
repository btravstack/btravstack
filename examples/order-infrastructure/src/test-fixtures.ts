import { randomUUID } from "node:crypto";

import type { ServiceOf } from "@btravstack/di";
import type {
  CustomerRepository,
  Outbox,
  OrderRepository,
} from "@btravstack/example-order-application";
import { placeOrder, type Order } from "@btravstack/example-order-domain";
import { inject, test } from "vitest";

import {
  openDatabase,
  prismaCustomerRepository,
  prismaOrderRepository,
  prismaOutbox,
  type OrderDatabaseClient,
} from "./index.js";

export type PersistenceFixtures = {
  /**
   * A client on the shared PostgreSQL database, already migrated by
   * `src/global-setup.ts`. It is the SAME database every other test in the
   * repository uses — nothing is created, truncated or dropped per test,
   * because nothing needs to be: `tenant` is what separates them.
   */
  readonly db: OrderDatabaseClient;
  /**
   * This test's tenant, and nobody else's. A UUID, so it is unique across
   * spec files and across the workspaces running concurrently — which is the
   * whole trick: a shared database costs one migration for the run instead of
   * one per test, and isolation comes from the tenant column rather than from
   * a database nobody else can see.
   *
   * Every repository call takes it as its first argument, because the ports
   * say so. There is no fixture that "enters" a tenant and no ambient store to
   * set — which is exactly what makes these specs readable: what a call is
   * scoped to is written at the call.
   */
  readonly tenant: string;
  readonly repository: ServiceOf<OrderRepository>;
  readonly customers: ServiceOf<CustomerRepository>;
  readonly outbox: ServiceOf<Outbox>;
  readonly anOrder: (id: string, quantity: number) => Order;
  /**
   * Puts a customer in this test's tenant. Straight through the client, past
   * the port, because the port is read-only by design: this application
   * registers nobody, so a row written by something else is exactly what it
   * reads.
   */
  readonly aCustomer: (id: string, name: string) => Promise<void>;
};

export const it = test.extend<PersistenceFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  db: async ({}, use) => {
    // `.get()` compiles only on a `Result<T, never>`, which is exactly what
    // `openDatabase` returns — and it panics on a Defect, which is what a test
    // wants from a database that would not open.
    const db = (await openDatabase(inject("__ORDERS_DATABASE_URL__"))).get();
    await use(db);
    await db.$disconnect();
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  tenant: async ({}, use) => {
    await use(`t-${randomUUID()}`);
  },

  repository: async ({ db }, use) => {
    await use(prismaOrderRepository(db));
  },

  customers: async ({ db }, use) => {
    await use(prismaCustomerRepository(db));
  },

  outbox: async ({ db }, use) => {
    await use(prismaOutbox(db));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  anOrder: async ({}, use) => {
    await use((id, quantity) => placeOrder(id, quantity).getOrThrow());
  },

  aCustomer: async ({ db, tenant }, use) => {
    await use(async (id, name) => {
      await db.customer.create({ data: { tenantId: tenant, customerId: id, name } });
    });
  },
});
