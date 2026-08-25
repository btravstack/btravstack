import { Module } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { FindOrder, PlaceOrder } from "./index.js";

describe("PlaceOrder", () => {
  it("persists a placed order, readable through FindOrder", async ({ testModule }) => {
    // GIVEN the application wired over an in-memory repository
    // WHEN an order is placed and then looked up
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001", 2)
        .flatMap(() =>
          ctx.get(FindOrder).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001"),
        ),
    );

    // THEN the write is visible to the read
    expect(result).toBeOkWith({ id: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 });
  });

  it("surfaces the repository's DuplicateOrder unchanged", async ({ testModule }) => {
    // GIVEN an id already used
    // WHEN it is placed a second time
    const result = await Module.scoped(testModule, (ctx) => {
      const placeOrder = ctx.get(PlaceOrder);
      return placeOrder
        .execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001", 1)
        .flatMap(() =>
          placeOrder.execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001", 1),
        );
    });

    // THEN the repository's own error reaches the caller untranslated
    expect(result).toBeErrTagged("DuplicateOrder", { id: "0199a1e0-0000-7000-8000-000000000001" });
  });

  it("rejects a non-positive quantity without reaching the repository", async ({ testModule }) => {
    // GIVEN a quantity the domain invariant rejects
    // WHEN it is placed
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(PlaceOrder).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001", 0),
    );

    // THEN the domain error short-circuits the use case
    expect(result).toBeErrTagged("InvalidQuantity", {
      id: "0199a1e0-0000-7000-8000-000000000001",
      quantity: 0,
    });
  });

  it("rejects a malformed id without blaming the quantity", async ({ testModule }) => {
    // GIVEN an id the domain's `OrderId` format rejects, and a fine quantity
    // WHEN it is placed
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(PlaceOrder).execute(TenantId("acme"), "o-1", 2),
    );

    // THEN the widened channel carries the id's own error to the caller
    expect(result).toBeErrTagged("InvalidOrderId", { id: "o-1" });
  });

  it("writes a log line carrying the order as fields", async ({ testModule, recorder }) => {
    // GIVEN a successful placement
    // WHEN the sink the graph's logger writes to is read back
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001", 2)
        .map(() => recorder.lines()),
    );

    // THEN the ids are queryable attributes rather than words in a sentence,
    // and there is no unit here to take a trace id from
    expect(result).toBeOkWith([
      expect.objectContaining({
        level: "info",
        message: "placing an order",
        attributes: {
          tenantId: "acme",
          orderId: "0199a1e0-0000-7000-8000-000000000001",
          quantity: 2,
        },
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
        .execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000501", 2)
        .flatMap(() =>
          placeOrder.execute(TenantId("globex"), "0199a1e0-0000-7000-8000-000000000501", 7),
        )
        .flatMap(() =>
          ctx.get(FindOrder).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000501"),
        );
    });

    // WHEN the first tenant reads that id back
    // THEN it gets its own order: the tenant is an argument the use case
    // carries, so nothing about the wiring can leak one tenant into another
    expect(result).toBeOkWith({ id: "0199a1e0-0000-7000-8000-000000000501", quantity: 2 });
  });
});

describe("FindOrder", () => {
  it("returns OrderNotFound for an unknown id", async ({ testModule }) => {
    // GIVEN an empty repository
    // WHEN an unknown id is looked up
    const result = await Module.scoped(testModule, (ctx) =>
      ctx.get(FindOrder).execute(TenantId("acme"), "missing"),
    );

    // THEN absence is a modeled error, not an empty success
    expect(result).toBeErrTagged("OrderNotFound", { id: "missing" });
  });
});
