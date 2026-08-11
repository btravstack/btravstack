import { Module, Provider } from "@btravstack/di";
import { DuplicateOrder, OrderNotFound, type Order } from "@btravstack/start-example-order-domain";
import { ErrAsync, OkAsync } from "unthrown";
import { test } from "vitest";

import { ApplicationModule, FindOrder, Logger, OrderRepository, PlaceOrder } from "./index.js";

/**
 * The whole point of the layer split: the use cases run against a stub
 * repository provided by a module that exists only in this file. No database,
 * no HTTP, no kernel — the application layer is exercised with the
 * infrastructure hole still open, and `TestModule` compiles only because
 * providing `OrderRepository` is what closes `ApplicationModule`'s one need.
 */
const stubRepository = Provider(OrderRepository)({
  sync: () => {
    const rows = new Map<string, Order>();
    return {
      save: (order: Order) => {
        if (rows.has(order.id)) return ErrAsync(new DuplicateOrder({ id: order.id }));
        rows.set(order.id, order);
        return OkAsync(order);
      },
      find: (id: string) => {
        const row = rows.get(id);
        return row === undefined ? ErrAsync(new OrderNotFound({ id })) : OkAsync(row);
      },
    };
  },
});

const TestModule = Module("Test")({
  imports: [ApplicationModule],
  provides: [stubRepository],
  exports: [PlaceOrder, FindOrder, Logger],
});

export type ApplicationFixtures = {
  /** `ApplicationModule` with its one unmet need closed by an in-memory stub. */
  readonly testModule: typeof TestModule;
};

export const it = test.extend<ApplicationFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  testModule: async ({}, use) => {
    await use(TestModule);
  },
});
