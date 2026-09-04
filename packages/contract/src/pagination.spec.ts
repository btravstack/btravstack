import { describe, expect } from "vitest";
import { z } from "zod";

import { it } from "./__tests__/test-fixtures.js";
import { page, pageRequest } from "./index.js";
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
