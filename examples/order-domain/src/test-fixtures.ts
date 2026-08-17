import { test } from "vitest";

import { Customer, placeOrder, type Order } from "./index.js";

export type DomainFixtures = {
  /** A valid entity, built the way the outside world builds one. */
  readonly placed: Order;
  /** The other entity, built the way an adapter rebuilds one from a row. */
  readonly customer: Customer;
};

export const it = test.extend<DomainFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  placed: async ({}, use) => {
    await use(placeOrder("o-1", 2).getOrThrow());
  },

  // oxlint-disable-next-line no-empty-pattern -- see above
  customer: async ({}, use) => {
    await use(Customer.make({ id: "c-1", name: "Ada" }).getOrThrow());
  },
});
