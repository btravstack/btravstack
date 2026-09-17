import { describe, expect } from "vitest";
import { z } from "zod";

import { it } from "./__tests__/test-fixtures.js";
import { keyset, page, pageRequest } from "./index.js";
import { pageOf, pageRequestOf } from "./zod.js";

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
