import { Module } from "@btravstack/di";
import { describe, expect, it } from "vitest";

import { AppModule, PlaceOrder } from "./app.js";

describe("AppModule", () => {
  it("places an order through the wired use case", async () => {
    const result = await Module.scoped(AppModule, (ctx) => ctx.get(PlaceOrder).execute("o-1", 2));

    expect(result).toBeOkWith({ id: "o-1", quantity: 2 });
  });

  it("returns DuplicateOrder for an id already placed", async () => {
    const result = await Module.scoped(AppModule, (ctx) => {
      const placeOrder = ctx.get(PlaceOrder);
      return placeOrder.execute("o-1", 1).flatMap(() => placeOrder.execute("o-1", 1));
    });

    expect(result).toBeErrTagged("DuplicateOrder", { id: "o-1" });
  });

  it("returns OrderNotFound for an unknown id", async () => {
    const result = await Module.scoped(AppModule, (ctx) => ctx.get(PlaceOrder).find("missing"));

    expect(result).toBeErrTagged("OrderNotFound", { id: "missing" });
  });
});
