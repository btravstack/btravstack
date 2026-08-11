import { describe, expect, it } from "vitest";

import { DuplicateOrder, InvalidQuantity, OrderNotFound, placeOrder } from "./index.js";

describe("placeOrder", () => {
  it("returns an order for a positive quantity", () => {
    expect(placeOrder("o-1", 2)).toBeOkWith({ id: "o-1", quantity: 2 });
  });

  it("rejects a quantity of zero", () => {
    expect(placeOrder("o-1", 0)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 0 });
  });

  it("rejects a negative quantity", () => {
    expect(placeOrder("o-1", -3)).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: -3 });
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
