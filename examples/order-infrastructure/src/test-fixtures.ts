import type { ServiceOf } from "@btravstack/di";
import type { Outbox, OrderRepository } from "@btravstack/start-example-order-application";
import { placeOrder, type Order } from "@btravstack/start-example-order-domain";
import { test } from "vitest";

import {
  openDatabase,
  prismaOrderRepository,
  prismaOutbox,
  type OrderDatabaseClient,
} from "./index.js";

export type PersistenceFixtures = {
  /**
   * A fresh in-memory database with the schema applied. Disconnecting is the
   * fixture's job, so no test needs a `finally` to reach it — and the cleanup
   * still runs when the test body fails.
   */
  readonly db: OrderDatabaseClient;
  readonly repository: ServiceOf<OrderRepository>;
  readonly outbox: ServiceOf<Outbox>;
  readonly anOrder: (id: string, quantity: number) => Order;
};

export const it = test.extend<PersistenceFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  db: async ({}, use) => {
    // `.get()` compiles only on a `Result<T, never>`, which is exactly what
    // `openDatabase` returns — and it panics on a Defect, which is what a test
    // wants from a database that would not open.
    const db = (await openDatabase()).get();
    await use(db);
    await db.$disconnect();
  },

  repository: async ({ db }, use) => {
    await use(prismaOrderRepository(db));
  },

  outbox: async ({ db }, use) => {
    await use(prismaOutbox(db));
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  anOrder: async ({}, use) => {
    await use((id, quantity) => placeOrder(id, quantity).getOrThrow());
  },
});
