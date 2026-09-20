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

const SORT = { field: "quantity", direction: "asc" } as const;

describe("ListOrders", () => {
  it("answers one page and the cursor that continues it", async ({ scopeFor }) => {
    // GIVEN three orders placed for one tenant
    // WHEN two are asked for, sorted ascending by quantity
    const result = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(C, 9))
        .flatMap(() => ctx.get(ListOrders).execute({ limit: 2, sort: SORT })),
    );

    // THEN the page is full, in ascending quantity order — A (1), then B (5) —
    // and it hands back a cursor for the rest — the one field a caller loops
    // on. Its VALUE is deliberately not asserted: a cursor is opaque above the
    // adapter, and pinning it here would teach that it is an order id, which
    // is true of this stub and not of Postgres
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: A }), expect.objectContaining({ id: B })],
      hasPreviousPage: false,
      nextCursor: expect.any(String),
      hasNextPage: true,
    });
  });

  it("closes the listing with no cursor at all on the last page", async ({ scopeFor }) => {
    // GIVEN the same three orders
    // WHEN the page after the first page's own cursor is asked for — round
    // tripped rather than spelled, which is how a caller uses it
    const result = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(C, 9))
        .flatMap(() => ctx.get(ListOrders).execute({ limit: 2, sort: SORT }))
        .flatMap((page) =>
          ctx.get(ListOrders).execute({
            limit: 2,
            sort: SORT,
            ...(page.hasNextPage ? { after: page.nextCursor } : {}),
          }),
        ),
    );

    // THEN there is no `nextCursor` field to follow, rather than a cursor that
    // would return nothing — the flag and the cursor are one fact. C (9) is the
    // last order in ascending quantity order, so it is what remains
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: C })],
      previousCursor: expect.any(String),
      hasPreviousPage: true,
      hasNextPage: false,
    });
  });

  it("pages backward from the cursor a page handed back", async ({ scopeFor }) => {
    // GIVEN three orders, and the second page taken by following `nextCursor`
    // WHEN the page BEFORE that one is asked for
    const result = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(C, 9))
        .flatMap(() => ctx.get(ListOrders).execute({ limit: 2, sort: SORT }))
        .flatMap((page) =>
          ctx.get(ListOrders).execute({
            limit: 2,
            sort: SORT,
            ...(page.hasNextPage ? { after: page.nextCursor } : {}),
          }),
        )
        .flatMap((page) =>
          ctx.get(ListOrders).execute({
            limit: 2,
            sort: SORT,
            ...(page.hasPreviousPage ? { before: page.previousCursor } : {}),
          }),
        ),
    );

    // THEN the first page comes back, in the collection's own ascending-quantity
    // order — a backward page reads the way a forward one does, so a "previous"
    // link does not reverse what the reader is looking at
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: A }), expect.objectContaining({ id: B })],
      hasPreviousPage: false,
      nextCursor: expect.any(String),
      hasNextPage: true,
    });
  });

  it("applies the filter", async ({ scopeFor }) => {
    // GIVEN three orders of different sizes
    // WHEN only the large ones are asked for
    const result = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(A, 1)
        .flatMap(() => ctx.get(PlaceOrder).execute(B, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(C, 9))
        .flatMap(() => ctx.get(ListOrders).execute({ limit: 10, minQuantity: 5, sort: SORT })),
    );

    // THEN the small one is not in the page, and what remains is ascending by
    // quantity — B (5), then C (9)
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: B }), expect.objectContaining({ id: C })],
      hasPreviousPage: false,
      hasNextPage: false,
    });
  });

  it("never pages across tenants", async ({ scopeFor }) => {
    // GIVEN one order for each of two tenants, over the one store
    // WHEN one tenant lists
    const result = await Module.scoped(scopeFor(OTHER), (ctx) =>
      ctx.get(PlaceOrder).execute(B, 5),
    ).flatMap(() =>
      Module.scoped(scopeFor(ACME), (ctx) =>
        ctx
          .get(PlaceOrder)
          .execute(A, 1)
          .flatMap(() => ctx.get(ListOrders).execute({ limit: 10, sort: SORT })),
      ),
    );

    // THEN it sees its own and nothing else — the scope names the tenant, so
    // the other tenant's page is not a request this can express
    expect(result).toBeOkWith({
      items: [expect.objectContaining({ id: A })],
      hasPreviousPage: false,
      hasNextPage: false,
    });
  });

  it("refuses a cursor naming no order", async ({ scopeFor }) => {
    // GIVEN one order placed, and a cursor shaped for the declared sort but
    // naming a row that was never placed
    const cursor = "quantity:asc|999|0199a1e0-0000-7000-8000-00000000000f";

    // WHEN a page is asked for after that cursor
    const result = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(A, 1)
        .flatMap(() => ctx.get(ListOrders).execute({ limit: 2, sort: SORT, after: cursor })),
    );

    // THEN it is the modeled error carrying the parsed cursor, not the first
    // page — the stub answers what the Prisma adapter answers, so a spec cannot
    // pass here and fail against Postgres
    expect(result).toBeErrTagged("MalformedCursor", {
      cursor: "999|0199a1e0-0000-7000-8000-00000000000f",
    });
  });

  it("pages rows that tie on the sort key without skipping or repeating one", async ({
    scopeFor,
  }) => {
    // GIVEN four orders, three of which tie on quantity
    const TIE1 = "0199a1e0-0000-7000-8000-00000000000d";
    const TIE2 = "0199a1e0-0000-7000-8000-00000000000e";
    const TIE3 = "0199a1e0-0000-7000-8000-00000000000f";
    const LOW = "0199a1e0-0000-7000-8000-000000000010";
    const sort = { field: "quantity", direction: "desc" } as const;

    // WHEN the listing is walked a page at a time, sorted by the tied column
    const walked = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx
        .get(PlaceOrder)
        .execute(TIE1, 5)
        .flatMap(() => ctx.get(PlaceOrder).execute(TIE2, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(TIE3, 5))
        .flatMap(() => ctx.get(PlaceOrder).execute(LOW, 1))
        .flatMap(() => ctx.get(ListOrders).execute({ limit: 2, sort }))
        .flatMap((first) =>
          ctx
            .get(ListOrders)
            .execute({
              limit: 2,
              sort,
              ...(first.hasNextPage ? { after: first.nextCursor } : {}),
            })
            .map((second) => [...first.items, ...second.items].map((order) => order.id)),
        ),
    );

    // THEN every row is seen exactly once: descending reverses both the
    // quantity and its id tiebreak, so the tied trio comes back id-descending,
    // with the untied, lower-quantity row last
    expect(walked).toBeOkWith([TIE3, TIE2, TIE1, LOW]);
  });

  it("refuses a cursor issued under a different sort", async ({ scopeFor }) => {
    // GIVEN a cursor minted under `quantity desc`
    const cursor = "quantity:desc|5|0199a1e0-0000-7000-8000-00000000000a";

    // WHEN the same cursor is replayed under `quantity asc`
    const result = await Module.scoped(scopeFor(ACME), (ctx) =>
      ctx.get(ListOrders).execute({ limit: 2, sort: SORT, after: cursor }),
    );

    // THEN it is refused as its own fact, not as a malformed token
    expect(result).toBeErrTagged("CursorSortMismatch", { cursor });
  });
});
