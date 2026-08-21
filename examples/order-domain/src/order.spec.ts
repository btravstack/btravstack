import { P } from "unthrown";
import { describe, expect } from "vitest";

import {
  DuplicateOrder,
  InvalidOrderId,
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
    // WHEN it is read back
    // THEN it is the entity itself, carrying what was asked for. `constructor`
    // is read through the prototype chain, so the class `toBeInstanceOf` used
    // to check on its own is pinned inside the one assertion.
    expect(placed).toEqual(
      expect.objectContaining({
        constructor: Order,
        id: "0199a1e0-0000-7000-8000-000000000001",
        quantity: 2,
      }),
    );
  });

  it("reports a zero quantity as a value, never a throw", () => {
    // GIVEN a quantity the invariant rejects
    // WHEN it is placed
    // THEN the failure comes back in the error channel
    expect(placeOrder("0199a1e0-0000-7000-8000-000000000001", 0)).toBeErrTagged("InvalidQuantity", {
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 0,
    });
  });

  it("reports a negative quantity as a value, never a throw", () => {
    // GIVEN a quantity the invariant rejects
    // WHEN it is placed
    // THEN the failure comes back in the error channel
    expect(placeOrder("0199a1e0-0000-7000-8000-000000000001", -3)).toBeErrTagged(
      "InvalidQuantity",
      { id: "0199a1e0-0000-7000-8000-000000000001", quantity: -3 },
    );
  });

  it("names a malformed id rather than blaming the quantity", () => {
    // GIVEN an id that is not a UUIDv7, and a quantity that is fine
    const id = "o-1";

    // WHEN it is placed
    const result = placeOrder(id, 2);

    // THEN the failure names the id, not the field the caller got right
    expect(result).toBeErrWith(expect.objectContaining({ constructor: InvalidOrderId, id }));
  });

  it("blames the id when both fields are wrong", () => {
    // GIVEN an id that is not a UUIDv7 AND a quantity the rules reject
    const id = "o-1";

    // WHEN it is placed
    const result = placeOrder(id, 0);

    // THEN the id wins: it is the failure a caller is least likely to spot
    expect(result).toBeErrWith(expect.objectContaining({ constructor: InvalidOrderId, id }));
  });

  it("rejects a quantity that is not a whole number of items", () => {
    // GIVEN a fractional quantity
    // WHEN it is placed
    // THEN it fails the same rule as a non-positive one
    expect(placeOrder("0199a1e0-0000-7000-8000-000000000001", 2.5)).toBeErrTagged(
      "InvalidQuantity",
      { id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2.5 },
    );
  });
});

describe("Order", () => {
  it("carries the failing rule in the entity's own issues", () => {
    // GIVEN a construction the invariant rejects
    const rejected = Order.make({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 0 });

    // WHEN its error channel is folded
    const message = rejected.match({
      ok: () => "WRONGLY ACCEPTED",
      errCases: (matcher) =>
        matcher.with(P.tag("InvalidEntity"), (e) => e.issues[0]?.message ?? ""),
      defect: () => "defect",
    });

    // THEN the rule that failed is named in the entity's own issues
    expect(message).toBe(
      "order 0199a1e0-0000-7000-8000-000000000001 asks for 0 items, which is not a positive quantity",
    );
  });

  it("is non-writable at runtime, not merely readonly in the type", ({ placed }) => {
    // GIVEN a placed order
    // WHEN its own property descriptor is read
    // THEN the value is there and the slot is sealed. Asserted on the whole
    // descriptor rather than `descriptor?.writable`: an optional read would
    // compare `undefined` against the expectation instead of the entity.
    expect(Object.getOwnPropertyDescriptor(placed, "quantity")).toEqual({
      value: 2,
      writable: false,
      enumerable: true,
      configurable: false,
    });
  });

  it("throws on a write smuggled past the type", ({ placed }) => {
    // GIVEN a placed order
    // WHEN a field is written past the type
    // THEN the write throws rather than landing
    expect(() => {
      (placed as unknown as { quantity: number }).quantity = 9;
    }).toThrow(TypeError);
  });

  it("returns a new entity carrying the update", ({ placed }) => {
    // GIVEN a placed order of quantity 2
    // WHEN it is updated
    const raised = placed.update({ quantity: Quantity.parse(5) });

    // THEN the change landed on an entity of the same class
    expect(raised).toBeOkWith(
      expect.objectContaining({
        constructor: Order,
        id: "0199a1e0-0000-7000-8000-000000000001",
        quantity: 5,
      }),
    );
  });

  it("leaves the original untouched when it is updated", ({ placed }) => {
    // GIVEN a placed order of quantity 2
    // WHEN it is updated
    const raised = placed.update({ quantity: Quantity.parse(5) });

    // THEN the original still reads as it was placed — the `map` keeps the
    // update's own outcome in the same assertion, so a failed update cannot
    // pass as an untouched original
    expect(raised.map(() => placed.toJSON())).toBeOkWith({
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 2,
    });
  });

  it("re-runs the invariant on the patch", ({ placed }) => {
    // GIVEN a patch the invariant rejects
    // WHEN it is applied
    // THEN the rule runs again, on the update path too
    expect(placed.update({ quantity: Quantity.parse(0) })).toBeErrTagged("InvalidEntity");
  });

  it("refuses to patch the immutable id, even when it is smuggled past the type", ({ placed }) => {
    // GIVEN a patch aimed at the immutable id
    const rejected = placed.update({ id: "0199a1e0-0000-7000-8000-000000000002" } as never);

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

    // THEN the projection is the stored shape alone — the key list is asserted
    // beside the values, so a non-enumerable extra could not slip past a
    // value-only comparison
    expect({ stored, keys: Reflect.ownKeys(stored) }).toEqual({
      stored: { id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 },
      keys: ["id", "quantity"],
    });
  });
});

describe("domain errors", () => {
  it("names the order in an InvalidQuantity message", () => {
    // GIVEN the error, constructed with its payload
    // WHEN its message is read
    // THEN the order it is about is named in it
    expect(
      new InvalidQuantity({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 0 }).message,
    ).toBe(
      "order 0199a1e0-0000-7000-8000-000000000001 asks for 0 items, which is not a positive quantity",
    );
  });

  it("names the id in an InvalidOrderId message", () => {
    // GIVEN the error, constructed with its payload
    // WHEN its message is read
    // THEN the id it is about is named in it
    expect(new InvalidOrderId({ id: "o-1" }).message).toBe("order id o-1 is not a UUIDv7");
  });

  it("names the order in an OrderNotFound message", () => {
    // GIVEN the error, constructed with its payload
    // WHEN its message is read
    // THEN the order it is about is named in it
    expect(new OrderNotFound({ id: "0199a1e0-0000-7000-8000-000000000002" }).message).toBe(
      "no order with id 0199a1e0-0000-7000-8000-000000000002",
    );
  });

  it("names the order in a DuplicateOrder message", () => {
    // GIVEN the error, constructed with its payload
    // WHEN its message is read
    // THEN the order it is about is named in it
    expect(new DuplicateOrder({ id: "0199a1e0-0000-7000-8000-000000000003" }).message).toBe(
      "order 0199a1e0-0000-7000-8000-000000000003 already exists",
    );
  });
});
