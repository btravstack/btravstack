import { P } from "unthrown";
import { describe, expect, it } from "vitest";

import {
  DuplicateOrder,
  InvalidQuantity,
  Order,
  OrderNotFound,
  Quantity,
  placeOrder,
} from "./index.js";

const placed = () => placeOrder("o-1", 2).getOrThrow();

describe("placeOrder", () => {
  it("constructs a real entity for a positive quantity", () => {
    const order = placed();

    expect(order).toBeInstanceOf(Order);
    expect(order.id).toBe("o-1");
    expect(order.quantity).toBe(2);
  });

  it("reports a violated invariant as a value, never a throw", () => {
    expect(placeOrder("o-1", 0)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 0 });
    expect(placeOrder("o-1", -3)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: -3 });
  });

  it("rejects a quantity that is not a whole number of items", () => {
    expect(placeOrder("o-1", 2.5)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 2.5 });
  });
});

describe("Order", () => {
  it("carries the failing rule in the entity's own issues", () => {
    const message = Order.make({ id: "o-1", quantity: 0 }).match({
      ok: () => "WRONGLY ACCEPTED",
      errCases: (matcher) =>
        matcher.with(P.tag("InvalidEntity"), (e) => e.issues[0]?.message ?? ""),
      defect: () => "defect",
    });

    expect(message).toBe("order o-1 asks for 0 items, which is not a positive quantity");
  });

  it("is immutable at runtime, not merely readonly in the type", () => {
    const order = placed();

    expect(Object.getOwnPropertyDescriptor(order, "quantity")?.writable).toBe(false);
    expect(() => {
      (order as unknown as { quantity: number }).quantity = 9;
    }).toThrow(TypeError);
  });

  it("re-runs the invariant on update, and leaves the original alone", () => {
    const order = placed();
    const raised = order.update({ quantity: Quantity.parse(5) }).getOrThrow();

    expect(raised.quantity).toBe(5);
    expect(order.quantity).toBe(2);
    expect(order.update({ quantity: Quantity.parse(0) }).isErr()).toBe(true);
  });

  it("refuses to patch the immutable id, even when it is smuggled past the type", () => {
    const rejected = placed().update({ id: "o-2" } as never);

    const message = rejected.match({
      ok: () => "WRONGLY ACCEPTED",
      errCases: (matcher) =>
        matcher.with(P.tag("InvalidEntity"), (e) => e.issues[0]?.message ?? ""),
      defect: () => "defect",
    });

    expect(message).toBe("Immutable field — cannot be patched");
  });

  it("projects exactly the stored shape, and never the entity tag", () => {
    const stored = placed().toJSON();

    expect(stored).toEqual({ id: "o-1", quantity: 2 });
    expect("_tag" in stored).toBe(false);
  });
});

describe("domain errors", () => {
  it("names the order in every message", () => {
    expect(new InvalidQuantity({ id: "o-1", quantity: 0 }).message).toBe(
      "order o-1 asks for 0 items, which is not a positive quantity",
    );
    expect(new OrderNotFound({ id: "o-2" }).message).toBe("no order with id o-2");
    expect(new DuplicateOrder({ id: "o-3" }).message).toBe("order o-3 already exists");
  });
});
