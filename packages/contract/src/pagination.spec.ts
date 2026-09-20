import { describe, expect } from "vitest";
import { z } from "zod";

import { it } from "./__tests__/test-fixtures.js";
import { keyset, page, pageRequest } from "./index.js";
import { pageOf, pageRequestOf, sortableBy } from "./zod.js";

describe("page", () => {
  it("derives each side's flag from whether that side has a cursor", () => {
    // GIVEN a listing that can go forward but not back
    const items = [{ id: "a" }];

    // WHEN the page is built from its cursors
    const built = page(items, { previous: null, next: "n" });

    // THEN the open side carries its cursor and the closed side has no field
    expect(built).toEqual({
      items,
      hasPreviousPage: false,
      hasNextPage: true,
      nextCursor: "n",
    });
  });

  it("parses against its own schema, for every page that exists", () => {
    // GIVEN the schema of a page and the four cursor pairs a listing can be in
    const schema = pageOf(z.object({ id: z.string() }));
    const pairs = [
      { previous: null, next: null },
      { previous: null, next: "n" },
      { previous: "p", next: null },
      { previous: "p", next: "n" },
    ];

    // WHEN each page the constructor builds is parsed by the schema
    const parsed = pairs.map((cursors) => schema.safeParse(page([{ id: "a" }], cursors)).success);

    // THEN all four round-trip: the type and the wire shape are one thing,
    // which the type test cannot say because `readonly` does not survive here
    expect(parsed).toEqual([true, true, true, true]);
  });
});

describe("pageOf", () => {
  it("refuses a cursor on a side whose flag says it is closed", () => {
    // GIVEN a page claiming there is nothing next, and a cursor to follow it
    const schema = pageOf(z.object({ id: z.string() }));

    // WHEN it is parsed
    const parsed = schema.safeParse({
      items: [],
      hasPreviousPage: false,
      hasNextPage: false,
      nextCursor: "n",
    });

    // THEN it is refused rather than stripped: the arms are closed objects, and
    // the emitted schema already says so
    expect(parsed).toMatchObject({ success: false });
  });
});

describe("pageRequestOf", () => {
  it("refuses both cursors at once", () => {
    // GIVEN a request that asks to page in both directions
    const schema = pageRequestOf({});

    // WHEN it is parsed
    const parsed = schema.safeParse({ limit: 10, after: "a", before: "b" });

    // THEN the schema refuses it, so the refusal is published rather than left
    // to a handler
    expect(parsed).toMatchObject({ success: false });
  });

  it("fills in the default limit a listing asked for", () => {
    // GIVEN a listing with its own default
    const schema = pageRequestOf({}, { defaultLimit: 5, maxLimit: 10 });

    // WHEN a caller names no limit
    const parsed = schema.safeParse({});

    // THEN the listing's default is what it gets
    expect(parsed).toMatchObject({ success: true, data: { limit: 5 } });
  });

  it("holds the ceiling a listing asked for", () => {
    // GIVEN the same listing
    const schema = pageRequestOf({}, { defaultLimit: 5, maxLimit: 10 });

    // WHEN a caller asks for a page past it
    const parsed = schema.safeParse({ limit: 11 });

    // THEN the ceiling refuses it
    expect(parsed).toMatchObject({ success: false });
  });

  it("refuses a default limit its own ceiling forbids", () => {
    // GIVEN a listing configured with a default above its ceiling
    const schema = pageRequestOf({}, { defaultLimit: 101, maxLimit: 100 });

    // WHEN a caller names no limit at all
    const parsed = schema.safeParse({});

    // THEN the ceiling still binds. A `default` is handed back unparsed, and
    // would have served a page larger than the schema published.
    expect(parsed).toMatchObject({ success: false });
  });

  it("carries the listing's own filters through the schema", () => {
    // GIVEN a listing that filters by quantity
    const schema = pageRequestOf({ minQuantity: z.number().int() });

    // WHEN a request naming one is parsed and then narrowed
    const parsed = schema.parse({ after: "a", minQuantity: 2 });

    // THEN the filter survives beside the one-direction request
    expect(pageRequest(parsed)).toEqual({ limit: 20, after: "a", minQuantity: 2 });
  });
});

describe("pageRequest", () => {
  it("drops the absent cursor rather than carrying it as undefined", () => {
    // GIVEN a validated input whose caller named neither cursor
    const query = { limit: 20, after: undefined, before: undefined };

    // WHEN it is narrowed
    const narrowed = pageRequest(query);

    // THEN neither key is present: a `PageRequest` says which direction it runs
    // by which field it has, so an `undefined` one would be a third state
    expect(narrowed).toEqual({ limit: 20 });
  });

  it("keeps `before` when a caller somehow named both", () => {
    // GIVEN the pair the schema refuses, reaching the narrowing anyway
    const query = { limit: 20, after: "a", before: "b" };

    // WHEN it is narrowed
    const narrowed = pageRequest(query);

    // THEN one direction wins and the function stays total
    expect(narrowed).toEqual({ limit: 20, before: "b" });
  });
});

describe("keyset", () => {
  it("opens a listing with a next cursor and no way back", ({ store }) => {
    // GIVEN five rows and a request for the first two
    const keys = keyset({ limit: 2 });

    // WHEN the store is seeked and what it answered is folded
    const built = keys.page(store.seek(keys), (row) => String(row.id));

    // THEN the page carries the two rows asked for — never the extra one the
    // over-fetch bought — and only the side a caller can actually reach
    expect(built).toEqual({
      items: [
        { id: 1, label: "row-1" },
        { id: 2, label: "row-2" },
      ],
      hasPreviousPage: false,
      hasNextPage: true,
      nextCursor: "2",
    });
  });

  it("gives a continued page both sides, because it was reached from one", ({ store }) => {
    // GIVEN the cursor the first page handed back
    const keys = keyset({ limit: 2, after: "2" });

    // WHEN the listing continues
    const built = keys.page(store.seek(keys), (row) => String(row.id));

    // THEN `previous` exists because the caller came from somewhere, and it is
    // the page's OWN first row rather than the cursor that was handed in
    expect(built).toEqual({
      items: [
        { id: 3, label: "row-3" },
        { id: 4, label: "row-4" },
      ],
      hasPreviousPage: true,
      previousCursor: "3",
      hasNextPage: true,
      nextCursor: "4",
    });
  });

  it("closes the listing when the over-fetch comes back short", ({ store }) => {
    // GIVEN a cursor with one row left after it
    const keys = keyset({ limit: 2, after: "4" });

    // WHEN the last page is fetched
    const built = keys.page(store.seek(keys), (row) => String(row.id));

    // THEN there is no next cursor: the extra row is what would have proved
    // one, and asking for `limit + 1` is the only reason this is knowable
    // without a second count query
    expect(built).toEqual({
      items: [{ id: 5, label: "row-5" }],
      hasPreviousPage: true,
      previousCursor: "5",
      hasNextPage: false,
    });
  });

  it("hands a backward page back in reading order, not query order", ({ store }) => {
    // GIVEN a request to page BACKWARD from the fourth row
    const keys = keyset({ limit: 2, before: "4" });

    // WHEN the store walks descending and the rows are folded
    const built = keys.page(store.seek(keys), (row) => String(row.id));

    // THEN they arrive ascending, so a previous page reads the way a next one
    // does — and the extra row proves a page BEFORE this one rather than after,
    // while `next` is certain because `before` says the caller came from there
    expect(built).toEqual({
      items: [
        { id: 2, label: "row-2" },
        { id: 3, label: "row-3" },
      ],
      hasPreviousPage: true,
      previousCursor: "2",
      hasNextPage: true,
      nextCursor: "3",
    });
  });

  it("closes the far side when a backward page runs out of rows", ({ store }) => {
    // GIVEN a backward page wider than what is behind the cursor
    const keys = keyset({ limit: 4, before: "3" });

    // WHEN it is fetched
    const built = keys.page(store.seek(keys), (row) => String(row.id));

    // THEN the start of the listing has no previous cursor, where a fold that
    // read `more` as "there is a next page" would have minted one
    expect(built).toEqual({
      items: [
        { id: 1, label: "row-1" },
        { id: 2, label: "row-2" },
      ],
      hasPreviousPage: false,
      hasNextPage: true,
      nextCursor: "2",
    });
  });

  it("mints no cursor at all for a page with no rows to mint one from", ({ empty }) => {
    // GIVEN a listing that holds nothing, asked for from a cursor
    const keys = keyset({ limit: 2, after: "9" });

    // WHEN the empty answer is folded
    const built = keys.page(empty.seek(keys), (row) => String(row.id));

    // THEN both sides are closed: `after` alone would otherwise claim a
    // previous page, and there is no row to name one with
    expect(built).toEqual({ items: [], hasPreviousPage: false, hasNextPage: false });
  });

  it("takes the cursor off the row and the item off that same row", ({ store }) => {
    // GIVEN a listing whose items are not the rows it pages by
    const keys = keyset({ limit: 2 });

    // WHEN the fold is given both routes off one row
    const built = keys.page(
      store.seek(keys),
      (row) => String(row.id),
      (row) => row.label,
    );

    // THEN the page carries the mapped items while the cursor stays the key —
    // which is the ordinary adapter shape: seek on a surrogate, answer entities
    expect(built).toEqual({
      items: ["row-1", "row-2"],
      hasPreviousPage: false,
      hasNextPage: true,
      nextCursor: "2",
    });
  });

  it("asks for exactly one more row than the page it hands back", ({ store }) => {
    // GIVEN a request for three rows
    const keys = keyset({ limit: 3 });

    // WHEN what the store was asked for is compared with what came back
    const built = keys.page(store.seek(keys), (row) => String(row.id));

    // THEN the over-fetch and the trim agree by construction: they are two
    // halves of one object, and a store queried for `limit` then folded as
    // though it had been queried for `limit + 1` reports a next page forever
    expect({ take: keys.take, backward: keys.backward, items: built.items.length }).toEqual({
      take: 4,
      backward: false,
      items: 3,
    });
  });
});

describe("keyset, sorted", () => {
  it("mints a cursor carrying the sort it was issued under", () => {
    // GIVEN a sorted first page
    const keys = keyset({ limit: 2, sort: { field: "quantity", direction: "desc" } });

    // WHEN a page is folded from rows the store answered
    const built = keys.resumable
      ? keys.page(
          [
            { quantity: 9, id: 1 },
            { quantity: 9, id: 2 },
            { quantity: 8, id: 3 },
          ],
          (row) => [String(row.quantity), String(row.id)],
        )
      : undefined;

    // THEN the next cursor names the sort, then both values, in that order
    expect(built).toEqual({
      items: [
        { quantity: 9, id: 1 },
        { quantity: 9, id: 2 },
      ],
      hasPreviousPage: false,
      hasNextPage: true,
      nextCursor: "quantity:desc|9|2",
    });
  });

  it("resumes from a cursor issued under the same sort", () => {
    // GIVEN a cursor minted under `quantity desc`
    const request = {
      limit: 2,
      after: "quantity:desc|9|2",
      sort: { field: "quantity", direction: "desc" },
    } as const;

    // WHEN the keyset is taken for the same sort
    const keys = keyset(request);

    // THEN it resumes, handing the seek both values decoded
    expect(keys).toMatchObject({ resumable: true, backward: false, cursor: ["9", "2"] });
  });

  it("refuses a cursor issued under a different field", () => {
    // GIVEN a cursor minted under `quantity desc`
    const cursor = "quantity:desc|9|2";

    // WHEN it is replayed against a listing sorted by another field
    const keys = keyset({
      limit: 2,
      after: cursor,
      sort: { field: "placedAt", direction: "desc" },
    });

    // THEN it is refused as its own sort, naming the cursor that was refused —
    // it had a sort-shaped head, and named a different one
    expect(keys).toEqual({ resumable: false, cursor, reason: "sort-mismatch" });
  });

  it("refuses a cursor issued under the same field in the other direction", () => {
    // GIVEN a cursor minted under `quantity desc`
    const cursor = "quantity:desc|9|2";

    // WHEN it is replayed with the direction flipped
    const keys = keyset({ limit: 2, after: cursor, sort: { field: "quantity", direction: "asc" } });

    // THEN it is refused rather than served from the wrong side
    expect(keys).toEqual({ resumable: false, cursor, reason: "sort-mismatch" });
  });

  it("refuses a cursor missing the tiebreak value rather than seeking without it", () => {
    // GIVEN a cursor carrying the sort and one value
    const cursor = "quantity:desc|9";

    // WHEN it is replayed
    const keys = keyset({
      limit: 2,
      after: cursor,
      sort: { field: "quantity", direction: "desc" },
    });

    // THEN it is malformed: a partial keyset seeks on one column and skips
    // rows, and there is no full head-and-value shape to compare against a sort
    expect(keys).toEqual({ resumable: false, cursor, reason: "malformed" });
  });

  it("refuses a cursor with no sort-shaped head at all", () => {
    // GIVEN a cursor that never had a `field:direction` head to read
    const cursor = "invented";

    // WHEN it is replayed against a sorted listing
    const keys = keyset({
      limit: 2,
      after: cursor,
      sort: { field: "quantity", direction: "desc" },
    });

    // THEN it is malformed rather than a sort mismatch — there was no head to
    // compare against the declared sort in the first place
    expect(keys).toEqual({ resumable: false, cursor, reason: "malformed" });
  });

  it("refuses a three-part cursor whose head is not field:direction shaped", () => {
    // GIVEN a cursor with the right PART COUNT but no `field:direction` head —
    // the part-count check alone would let this one through
    const cursor = "a|b|c";

    // WHEN it is replayed against a sorted listing
    const keys = keyset({
      limit: 2,
      after: cursor,
      sort: { field: "quantity", direction: "desc" },
    });

    // THEN it is malformed: the head-pattern check is what catches it, not the
    // part count
    expect(keys).toEqual({ resumable: false, cursor, reason: "malformed" });
  });

  it("hands a backward page back in reading order", () => {
    // GIVEN a backward page whose store answered newest-first
    const keys = keyset({
      limit: 2,
      before: "quantity:desc|5|9",
      sort: { field: "quantity", direction: "desc" },
    });

    // WHEN three rows come back for a page of two
    const built = keys.resumable
      ? keys.page(
          [
            { quantity: 6, id: 3 },
            { quantity: 7, id: 2 },
            { quantity: 8, id: 1 },
          ],
          (row) => [String(row.quantity), String(row.id)],
        )
      : undefined;

    // THEN the extra row proves the side BEFORE, and the rows read ascending
    expect(built).toEqual({
      items: [
        { quantity: 7, id: 2 },
        { quantity: 6, id: 3 },
      ],
      hasPreviousPage: true,
      previousCursor: "quantity:desc|7|2",
      hasNextPage: true,
      nextCursor: "quantity:desc|6|3",
    });
  });

  it("round-trips a value containing the separator", () => {
    // GIVEN a sort value containing the separator, and the over-fetch row that
    // is what makes a next cursor exist to replay
    const keys = keyset({ limit: 1, sort: { field: "label", direction: "asc" } });
    const minted = keys.resumable
      ? keys.page(
          [
            { label: "a|b", id: 1 },
            { label: "c", id: 2 },
          ],
          (row) => [row.label, String(row.id)],
        )
      : undefined;

    // WHEN the cursor it minted is replayed
    const resumed = keyset({
      limit: 1,
      after: minted?.hasNextPage === true ? minted.nextCursor : "",
      sort: { field: "label", direction: "asc" },
    });

    // THEN the value survives encoding rather than splitting the cursor
    expect(resumed).toMatchObject({ resumable: true, cursor: ["a|b", "1"] });
  });
});

describe("pageRequestOf, sorted", () => {
  it("applies the declared default when the caller names no sort", () => {
    // GIVEN a listing that sorts by quantity, newest first by default
    const schema = pageRequestOf(
      {},
      {
        sortableBy: sortableBy(z.object({ id: z.string(), quantity: z.number() }), ["quantity"]),
        defaultSort: { field: "quantity", direction: "desc" },
      },
    );

    // WHEN an input naming no sort is parsed
    const parsed = schema.safeParse({});

    // THEN the default is applied, parsed rather than handed back raw
    expect(parsed).toMatchObject({
      success: true,
      data: { limit: 20, sort: { field: "quantity", direction: "desc" } },
    });
  });

  it("refuses a sort field the listing did not declare", () => {
    // GIVEN the same listing
    const schema = pageRequestOf(
      {},
      {
        sortableBy: sortableBy(z.object({ id: z.string(), quantity: z.number() }), ["quantity"]),
        defaultSort: { field: "quantity", direction: "desc" },
      },
    );

    // WHEN a caller asks for a field that is not sortable
    const parsed = schema.safeParse({ sort: { field: "id", direction: "asc" } });

    // THEN it is refused, rather than dropped and served under the default
    expect(parsed).toMatchObject({ success: false });
  });

  it("refuses a sort missing its direction", () => {
    // GIVEN the same listing
    const schema = pageRequestOf(
      {},
      {
        sortableBy: sortableBy(z.object({ id: z.string(), quantity: z.number() }), ["quantity"]),
        defaultSort: { field: "quantity", direction: "desc" },
      },
    );

    // WHEN a caller sends a field with no direction
    const parsed = schema.safeParse({ sort: { field: "quantity" } });

    // THEN it is refused: the pair is one fact
    expect(parsed).toMatchObject({ success: false });
  });

  it("carries a parsed sort through the narrowing into the port's request", () => {
    // GIVEN a parsed sorted input carrying a cursor
    const schema = pageRequestOf(
      { minQuantity: z.number().optional() },
      {
        sortableBy: sortableBy(z.object({ id: z.string(), quantity: z.number() }), ["quantity"]),
        defaultSort: { field: "quantity", direction: "desc" },
      },
    );
    const parsed = schema.parse({ after: "quantity:desc|9|2", minQuantity: 3 });

    // WHEN it crosses into the one-direction request
    const request = pageRequest(parsed);

    // THEN the sort rides across beside the filter and the cursor
    expect(request).toEqual({
      limit: 20,
      after: "quantity:desc|9|2",
      minQuantity: 3,
      sort: { field: "quantity", direction: "desc" },
    });
  });
});
