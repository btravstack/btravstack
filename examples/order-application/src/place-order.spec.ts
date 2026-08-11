import { Module, Provider } from "@btravstack/di";
import { DuplicateOrder, OrderNotFound, type Order } from "@btravstack/start-example-order-domain";
import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

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

describe("PlaceOrder", () => {
  it("persists a placed order, readable through FindOrder", async () => {
    const result = await Module.scoped(TestModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute("o-1", 2)
        .flatMap(() => ctx.get(FindOrder).execute("o-1")),
    );

    expect(result).toBeOkWith({ id: "o-1", quantity: 2 });
  });

  it("surfaces the repository's DuplicateOrder unchanged", async () => {
    const result = await Module.scoped(TestModule, (ctx) => {
      const placeOrder = ctx.get(PlaceOrder);
      return placeOrder.execute("o-1", 1).flatMap(() => placeOrder.execute("o-1", 1));
    });

    expect(result).toBeErrTagged("DuplicateOrder", { id: "o-1" });
  });

  it("rejects a non-positive quantity without reaching the repository", async () => {
    const result = await Module.scoped(TestModule, (ctx) => ctx.get(PlaceOrder).execute("o-1", 0));

    expect(result).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 0 });
  });

  it("writes a log line naming the order", async () => {
    const result = await Module.scoped(TestModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute("o-1", 2)
        .map(() => ctx.get(Logger).lines()),
    );

    expect(result).toBeOkWith(["[-] placing order o-1 (quantity 2)"]);
  });
});

describe("FindOrder", () => {
  it("returns OrderNotFound for an unknown id", async () => {
    const result = await Module.scoped(TestModule, (ctx) => ctx.get(FindOrder).execute("missing"));

    expect(result).toBeErrTagged("OrderNotFound", { id: "missing" });
  });
});
