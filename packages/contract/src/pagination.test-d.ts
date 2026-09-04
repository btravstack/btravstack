import { z } from "zod";

import { page, pageRequest, type Page, type PageRequest } from "./index.js";
import { pageOf, pageRequestOf } from "./zod.js";

const item = z.object({ id: z.string() });
type Item = z.infer<typeof item>;

// The gate this package exists for: what `pageOf` parses to is a `Page`, so a
// field dropped, loosened or renamed on either side fails a check.
type Parsed = z.infer<ReturnType<typeof pageOf<typeof item>>>;
const parsedIsAPage: Page<Item> = {} as Parsed;
void parsedIsAPage;

// A flag and its cursor are one fact: neither half is expressible alone.
// @ts-expect-error -- `hasNextPage: true` without the cursor that continues it
const openWithoutCursor: Page<Item> = { items: [], hasPreviousPage: false, hasNextPage: true };
void openWithoutCursor;

// @ts-expect-error -- a cursor on a side the flag says is closed
const closedWithCursor: Page<Item> = {
  items: [],
  hasPreviousPage: false,
  hasNextPage: false,
  nextCursor: "c",
};
void closedWithCursor;

// `page` derives the flags, so a caller never spells the pairing itself.
const derivedIsAPage: Page<Item> = page([{ id: "a" }], { previous: null, next: "c" });
void derivedIsAPage;

// A page request runs in ONE direction, and the union is what says so.
// @ts-expect-error -- `after` and `before` at once is a range query, not a page
const both: PageRequest = { limit: 20, after: "a", before: "b" };
void both;

// `pageRequest` narrows a validated input into that union, carrying the
// listing's own filters through untouched.
const narrowed = pageRequest({ limit: 20, after: "a", minQuantity: 2 });
const narrowedIsARequest: PageRequest = narrowed;
const filterSurvives: number = narrowed.minQuantity;
void narrowedIsARequest;
void filterSurvives;

// What `pageRequestOf` parses to is what `pageRequest` accepts, filters
// included — the second half of the same no-drift claim.
type ParsedRequest = z.output<ReturnType<typeof pageRequestOf<{ minQuantity: z.ZodNumber }>>>;
const parsedRequestNarrows: PageRequest & { readonly minQuantity: number } = pageRequest(
  {} as ParsedRequest,
);
void parsedRequestNarrows;

// The three fields a page owns are not a listing's to redefine: `.extend`
// overwrites, so a filter named `limit` would silently unbound it.
// @ts-expect-error -- `limit` is the page's own
const reservedLimit = pageRequestOf({ limit: z.string() });
void reservedLimit;

// @ts-expect-error -- and so is a cursor
const reservedCursor = pageRequestOf({ after: z.number() });
void reservedCursor;
