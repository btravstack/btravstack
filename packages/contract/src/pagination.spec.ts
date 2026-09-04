import { describe, expect, it } from "vitest";
import { z } from "zod";

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
    expect(parsed.success).toBe(false);
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

  it("applies the limit a listing asked for, and bounds it", () => {
    // GIVEN a listing with its own default and ceiling
    const schema = pageRequestOf({}, { defaultLimit: 5, maxLimit: 10 });

    // WHEN a caller names no limit, and another names one past the ceiling
    const outcome = {
      absent: schema.safeParse({}),
      overCeiling: schema.safeParse({ limit: 11 }).success,
    };

    // THEN the default fills in and the ceiling holds
    expect(outcome).toMatchObject({
      absent: { success: true, data: { limit: 5 } },
      overCeiling: false,
    });
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
    expect(Object.keys(narrowed)).toEqual(["limit"]);
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
