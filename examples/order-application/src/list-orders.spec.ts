import { Module } from "@btravstack/di";
import { TenantId } from "@btravstack/example-order-domain";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { ListOrders, PlaceOrder } from "./index.js";

const ACME = TenantId("acme");
const OTHER = TenantId("other");

const A = "0199a1e0-0000-7000-8000-00000000000a";
const B = "0199a1e0-0000-7000-8000-00000000000b";
const C = "0199a1e0-0000-7000-8000-00000000000c";

describe("ListOrders", () => {
  it("answers one page and the cursor that continues it", async ({ testModule }) => {
    // GIVEN three orders placed for one tenant
    // WHEN two are asked for
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(ACME, A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, C, 9))
        .flatMap(() => ctx.get(ListOrders).execute(ACME, { limit: 2 })),
    );

    // THEN the page is full, and it hands back A cursor for the rest — the one
    // field a caller loops on. Its VALUE is deliberately not asserted: a cursor
    // is opaque above the adapter, and pinning it here would teach that it is
    // an order id, which is true of this stub and not of Postgres
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: A }), expect.objectContaining({ id: B })],
      hasPreviousPage: false,
      nextCursor: expect.any(String),
      hasNextPage: true,
    });
  });

  it("closes the listing with no cursor at all on the last page", async ({ testModule }) => {
    // GIVEN the same three orders
    // WHEN the page after the first page's own cursor is asked for — round
    // tripped rather than spelled, which is how a caller uses it
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(ACME, A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, C, 9))
        .flatMap(() => ctx.get(ListOrders).execute(ACME, { limit: 2 }))
        .flatMap((page) =>
          ctx.get(ListOrders).execute(ACME, {
            limit: 2,
            ...(page.hasNextPage ? { after: page.nextCursor } : {}),
          }),
        ),
    );

    // THEN there is no `nextCursor` field to follow, rather than a cursor that
    // would return nothing — the flag and the cursor are one fact
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: C })],
      previousCursor: expect.any(String),
      hasPreviousPage: true,
      hasNextPage: false,
    });
  });

  it("pages backward from the cursor a page handed back", async ({ testModule }) => {
    // GIVEN three orders, and the second page taken by following `nextCursor`
    // WHEN the page BEFORE that one is asked for
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(ACME, A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, C, 9))
        .flatMap(() => ctx.get(ListOrders).execute(ACME, { limit: 2 }))
        .flatMap((page) =>
          ctx.get(ListOrders).execute(ACME, {
            limit: 2,
            ...(page.hasNextPage ? { after: page.nextCursor } : {}),
          }),
        )
        .flatMap((page) =>
          ctx.get(ListOrders).execute(ACME, {
            limit: 2,
            ...(page.hasPreviousPage ? { before: page.previousCursor } : {}),
          }),
        ),
    );

    // THEN the first page comes back, in the collection's own order — a
    // backward page reads the way a forward one does, so a "previous" link does
    // not reverse what the reader is looking at
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: A }), expect.objectContaining({ id: B })],
      hasPreviousPage: false,
      nextCursor: expect.any(String),
      hasNextPage: true,
    });
  });

  it("applies the filter", async ({ testModule }) => {
    // GIVEN three orders of different sizes
    // WHEN only the large ones are asked for
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(ACME, A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(ACME, C, 9))
        .flatMap(() => ctx.get(ListOrders).execute(ACME, { limit: 10, minQuantity: 5 })),
    );

    // THEN the small one is not in the page
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: B }), expect.objectContaining({ id: C })],
      hasPreviousPage: false,
      hasNextPage: false,
    });
  });

  it("never pages across tenants", async ({ testModule }) => {
    // GIVEN one order for each of two tenants
    // WHEN one tenant lists
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(ACME, A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(OTHER, B, 5))
        .flatMap(() => ctx.get(ListOrders).execute(ACME, { limit: 10 })),
    );

    // THEN it sees its own and nothing else — the tenant is a parameter of the
    // port, so the other tenant's page is not a request this can express
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: A })],
      hasPreviousPage: false,
      hasNextPage: false,
    });
  });

  it("refuses a cursor naming no order", async ({ testModule }) => {
    // GIVEN one order placed
    // WHEN a page is asked for after a cursor the listing never issued
    const result = await Module.scoped(testModule, (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(ACME, A, 1)
        .flatMap(() => ctx.get(ListOrders).execute(ACME, { limit: 2, after: "invented" })),
    );

    // THEN it is the modeled error carrying the offending string, not the first
    // page — the stub answers what the Prisma adapter answers, so a spec cannot
    // pass here and fail against Postgres
    expect(result).toBeErrTagged("MalformedCursor", { cursor: "invented" });
  });
});
