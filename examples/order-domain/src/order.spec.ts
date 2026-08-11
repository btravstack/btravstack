import { P } from "unthrown";
import { describe, expect } from "vitest";

import {
  DuplicateOrder,
  InvalidQuantity,
  Order,
  OrderNotFound,
  Quantity,
  placeOrder,
} from "./index.js";
import { it } from "./test-fixtures.js";

describe("placeOrder", () => {
  it("constructs a real entity for a positive quantity", ({ placed }) => {
    // GIVEN an order placed with a positive quantity
    // WHEN its fields are read
    // THEN it is the entity itself, carrying what was asked for
    expect(placed).toBeInstanceOf(Order);
    expect(placed.id).toBe("o-1");
    expect(placed.quantity).toBe(2);
  });

  it("reports a violated invariant as a value, never a throw", () => {
    // GIVEN quantities the invariant rejects
    // WHEN they are placed
    // THEN the failure comes back in the error channel
    expect(placeOrder("o-1", 0)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 0 });
    expect(placeOrder("o-1", -3)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: -3 });
  });

  it("rejects a quantity that is not a whole number of items", () => {
    // GIVEN a fractional quantity
    // WHEN it is placed
    // THEN it fails the same rule as a non-positive one
    expect(placeOrder("o-1", 2.5)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 2.5 });
  });
});

describe("Order", () => {
  it("carries the failing rule in the entity's own issues", () => {
    // GIVEN a construction the invariant rejects
    const rejected = Order.make({ id: "o-1", quantity: 0 });

    // WHEN its error channel is folded
    const message = rejected.match({
      ok: () => "WRONGLY ACCEPTED",
      errCases: (matcher) =>
        matcher.with(P.tag("InvalidEntity"), (e) => e.issues[0]?.message ?? ""),
      defect: () => "defect",
    });

    // THEN the rule that failed is named in the entity's own issues
    expect(message).toBe("order o-1 asks for 0 items, which is not a positive quantity");
  });

  it("is immutable at runtime, not merely readonly in the type", ({ placed }) => {
    // GIVEN a placed order
    // WHEN a field is written past the type
    // THEN the descriptor says non-writable, and the write throws
    expect(Object.getOwnPropertyDescriptor(placed, "quantity")?.writable).toBe(false);
    expect(() => {
      (placed as unknown as { quantity: number }).quantity = 9;
    }).toThrow(TypeError);
  });

  it("re-runs the invariant on update, and leaves the original alone", ({ placed }) => {
    // GIVEN a placed order of quantity 2
    // WHEN it is updated
    const raised = placed.update({ quantity: Quantity.parse(5) }).getOrThrow();

    // THEN a new entity carries the change, the original is untouched, and the
    // invariant runs again on the patch
    expect(raised.quantity).toBe(5);
    expect(placed.quantity).toBe(2);
    expect(placed.update({ quantity: Quantity.parse(0) }).isErr()).toBe(true);
  });

  it("refuses to patch the immutable id, even when it is smuggled past the type", ({ placed }) => {
    // GIVEN a patch aimed at the immutable id
    const rejected = placed.update({ id: "o-2" } as never);

    // WHEN its error channel is folded
    const message = rejected.match({
      ok: () => "WRONGLY ACCEPTED",
      errCases: (matcher) =>
        matcher.with(P.tag("InvalidEntity"), (e) => e.issues[0]?.message ?? ""),
      defect: () => "defect",
    });

    // THEN the entity refuses it by name
    expect(message).toBe("Immutable field — cannot be patched");
  });

  it("projects exactly the stored shape, and never the entity tag", ({ placed }) => {
    // GIVEN a placed order
    // WHEN it is projected for storage
    const stored = placed.toJSON();

    // THEN the projection is the stored shape alone
    expect(stored).toEqual({ id: "o-1", quantity: 2 });
    expect("_tag" in stored).toBe(false);
  });
});

describe("domain errors", () => {
  it("names the order in every message", () => {
    // GIVEN each domain error, constructed with its payload
    // WHEN its message is read
    // THEN the order it is about is named in it
    expect(new InvalidQuantity({ id: "o-1", quantity: 0 }).message).toBe(
      "order o-1 asks for 0 items, which is not a positive quantity",
    );
    expect(new OrderNotFound({ id: "o-2" }).message).toBe("no order with id o-2");
    expect(new DuplicateOrder({ id: "o-3" }).message).toBe("order o-3 already exists");
  });
});
