import { expectTypeOf } from "vitest";
import { z } from "zod";

import { keyset, page, pageRequest, type Page, type PageRequest, type Sort } from "./index.js";
import { pageOf, pageRequestOf, sortableBy } from "./zod.js";

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

// The fields a page owns are not a listing's to redefine: `.extend`
// overwrites, so a filter named `limit` would silently unbound it.
// @ts-expect-error -- `limit` is the page's own
const reservedLimit = pageRequestOf({ limit: z.string() });
void reservedLimit;

// @ts-expect-error -- and so is a cursor
const reservedCursor = pageRequestOf({ after: z.number() });
void reservedCursor;

// @ts-expect-error -- and so is the sort, which a filter would shadow
const reservedSort = pageRequestOf({ sort: z.string() });
void reservedSort;

// A sorted, narrowed query carries its `Sort`; an unsorted one has none to carry.
const sortedNarrowed = pageRequest({
  limit: 20,
  after: "a",
  sort: { field: "quantity" as const, direction: "desc" },
});
const sortedIsARequest: PageRequest<"quantity"> = sortedNarrowed;
void sortedIsARequest;

const unsortedNarrowed = pageRequest({ limit: 20, after: "a" });
// @ts-expect-error -- an unsorted narrowing carries no `sort` to satisfy a sorted `PageRequest`
const stillSorted: PageRequest<"quantity"> = unsortedNarrowed;
void stillSorted;

// A query either carries a sort or has no such field. An OPTIONAL one is
// neither: it would narrow to the unsorted `PageRequest` and then mint a
// pair-shaped cursor at runtime, which is a `TypeError` in the fold. Both
// spellings are refused, by two different mechanisms — the union's own arms,
// and the gate that covers what a union comparison lets through.
declare const looselySorted: { readonly limit: number; readonly sort?: Sort | undefined };
// @ts-expect-error -- `sort?: Sort | undefined` satisfies neither arm
pageRequest(looselySorted);

declare const exactlySorted: { readonly limit: number; readonly sort?: Sort };
// @ts-expect-error -- and neither does the `exactOptionalPropertyTypes` spelling
pageRequest(exactlySorted);

const view = z.object({
  id: z.string(),
  quantity: z.number(),
  cancelledAt: z.string().nullable(),
  note: z.string().optional(),
});

// A declared key must be a key of the item's own shape.
// @ts-expect-error -- `total` is not a key of `view`
sortableBy(view, ["total"]);

// A nullable key is refused: a null breaks the keyset comparison.
// @ts-expect-error -- `cancelledAt` is nullable
sortableBy(view, ["cancelledAt"]);

// An optional key is refused for the same reason.
// @ts-expect-error -- `note` is optional
sortableBy(view, ["note"]);

const sortable = sortableBy(view, ["quantity"]);
expectTypeOf(sortable).toEqualTypeOf<readonly ["quantity"]>();

// A sorted keyset's cursor callback must answer BOTH values.
const sorted = keyset({ limit: 10, sort: { field: "quantity", direction: "desc" } });
if (sorted.resumable) {
  // @ts-expect-error -- a bare key is not a keyset for a sorted listing
  sorted.page([{ id: "a", quantity: 1 }], (row) => row.id);
  expectTypeOf(sorted.cursor).toEqualTypeOf<readonly [string, string] | undefined>();
}

// An unsorted keyset still takes one string, and has no `resumable` to check.
const plain = keyset({ limit: 10 });
expectTypeOf(plain.cursor).toEqualTypeOf<string | undefined>();
expectTypeOf(plain.page([{ id: "a" }], (row) => row.id)).toEqualTypeOf<Page<{ id: string }>>();

// And it refuses the pair, so the arity runs both ways: a listing with no sort
// has one ordering column and nothing to tiebreak it against.
// @ts-expect-error -- a pair is not a keyset for an unsorted listing
plain.page([{ id: "a" }], (row) => [row.id, row.id]);
