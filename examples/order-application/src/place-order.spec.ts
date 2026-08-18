import { Module } from "@btravstack/di";
import { describe, expect } from "vitest";

import { FindOrder, PlaceOrder } from "./index.js";
import { it } from "./test-fixtures.js";

describe("PlaceOrder", () => {
  it("persists a placed order, readable through FindOrder", async ({ testModule }) => {
    // GIVEN the application wired over an in-memory repository
    // WHEN an order is placed and then looked up
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute("acme", "o-1", 2)
        .flatMap(() => ctx.get(FindOrder).execute("acme", "o-1")),
    );

    // THEN the write is visible to the read
    expect(result).toBeOkWith({ id: "o-1", quantity: 2 });
  });

  it("surfaces the repository's DuplicateOrder unchanged", async ({ testModule }) => {
    // GIVEN an id already used
    // WHEN it is placed a second time
    const result = await Module.scoped(testModule, (ctx) => {
      const placeOrder = ctx.get(PlaceOrder);
      return placeOrder
        .execute("acme", "o-1", 1)
        .flatMap(() => placeOrder.execute("acme", "o-1", 1));
    });

    // THEN the repository's own error reaches the caller untranslated
    expect(result).toBeErrTagged("DuplicateOrder", { id: "o-1" });
  });

  it("rejects a non-positive quantity without reaching the repository", async ({ testModule }) => {
    // GIVEN a quantity the domain invariant rejects
    // WHEN it is placed
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(PlaceOrder).execute("acme", "o-1", 0),
    );

    // THEN the domain error short-circuits the use case
    expect(result).toBeErrTagged("InvalidQuantity", { id: "o-1", quantity: 0 });
  });

  it("writes a log line carrying the order as fields", async ({ testModule, recorder }) => {
    // GIVEN a successful placement
    // WHEN the sink the graph's logger writes to is read back
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute("acme", "o-1", 2)
        .map(() => recorder.lines()),
    );

    // THEN the ids are queryable attributes rather than words in a sentence,
    // and there is no unit here to take a trace id from
    expect(result).toBeOkWith([
      expect.objectContaining({
        level: "info",
        message: "placing an order",
        attributes: { tenantId: "acme", orderId: "o-1", quantity: 2 },
        unit: undefined,
      }),
    ]);
  });
});

describe("tenancy", () => {
  it("keeps one tenant's order invisible to another", async ({ testModule }) => {
    // GIVEN the same order id placed by two tenants — which a single-tenant
    // repository would refuse as a duplicate
    const result = await Module.scoped(testModule, (ctx) => {
      const placeOrder = ctx.get(PlaceOrder);
      return placeOrder
        .execute("acme", "o-shared", 2)
        .flatMap(() => placeOrder.execute("globex", "o-shared", 7))
        .flatMap(() => ctx.get(FindOrder).execute("acme", "o-shared"));
    });

    // WHEN the first tenant reads that id back
    // THEN it gets its own order: the tenant is an argument the use case
    // carries, so nothing about the wiring can leak one tenant into another
    expect(result).toBeOkWith({ id: "o-shared", quantity: 2 });
  });
});

describe("FindOrder", () => {
  it("returns OrderNotFound for an unknown id", async ({ testModule }) => {
    // GIVEN an empty repository
    // WHEN an unknown id is looked up
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(FindOrder).execute("acme", "missing"),
    );

    // THEN absence is a modeled error, not an empty success
    expect(result).toBeErrTagged("OrderNotFound", { id: "missing" });
  });
});
