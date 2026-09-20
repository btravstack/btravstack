import { z } from "zod";

import type { Sort } from "./pagination.js";

/**
 * How large a page may be, and how large it is when the caller says nothing.
 *
 * Both are the API's decision rather than the framework's, so both are
 * overridable — the defaults are a listing that behaves reasonably when nobody
 * has thought about it yet.
 */
export type PageLimits = {
  /** The size of a page whose caller named none. Default `20`. */
  readonly defaultLimit?: number;
  /** The largest page a caller may ask for. Default `100`. */
  readonly maxLimit?: number;
};

/**
 * A filter shape that leaves the three fields a page owns alone.
 *
 * `.extend` overwrites rather than merges, so without this a filter named
 * `limit` would silently replace the bounded one, and one named `after` would
 * re-type a cursor. Naming any of the three is a compile error at the call.
 */
type ReservedKeysFree = z.ZodRawShape & {
  readonly [K in "limit" | "after" | "before" | "sort"]?: never;
};

/**
 * The schema of one page of `item`: the four pages that exist, as four closed
 * objects.
 *
 * A **union** rather than an intersection, because `allOf` of closed objects
 * validates nothing in JSON Schema and the emitted OpenAPI document is an
 * interop surface. `strictObject`, so a cursor on a closed side is refused
 * rather than stripped: the arms differ by which fields they carry, and the
 * schema this generates already says `additionalProperties: false` — a
 * stripping parser would accept what its own published schema rejects.
 *
 * What it parses to is assignable to `Page<T>`, which `pagination.test-d.ts`
 * pins, and every page `page` builds parses against it, which
 * `pagination.spec.ts` pins — so a field dropped, loosened or renamed on
 * either side fails a check. Widening `Page<T>` with a field no page carries
 * is the one drift neither sees.
 */
export const pageOf = <Item extends z.ZodType>(item: Item) => {
  const items = { items: z.array(item) };
  const noPrevious = { hasPreviousPage: z.literal(false) };
  const aPrevious = { hasPreviousPage: z.literal(true), previousCursor: z.string() };
  const noNext = { hasNextPage: z.literal(false) };
  const aNext = { hasNextPage: z.literal(true), nextCursor: z.string() };
  return z.union([
    z.strictObject({ ...items, ...noPrevious, ...noNext }),
    z.strictObject({ ...items, ...noPrevious, ...aNext }),
    z.strictObject({ ...items, ...aPrevious, ...noNext }),
    z.strictObject({ ...items, ...aPrevious, ...aNext }),
  ]);
};

/**
 * The keys of `item` that a keyset may sort on: every key whose schema is
 * neither optional nor nullable.
 *
 * A null in a sort key breaks a keyset — the comparison that walks the page
 * goes null and the page comes back empty — so a nullable key is refused here
 * rather than handled in every adapter.
 */
type SortableKeys<Shape extends z.ZodRawShape> = {
  readonly [K in keyof Shape]: Shape[K] extends z.ZodOptional<z.ZodType> | z.ZodNullable<z.ZodType>
    ? never
    : K;
}[keyof Shape] &
  string;

/**
 * The sortable vocabulary of a listing, checked against the item it answers.
 *
 * A curated set rather than every key: what a listing sorts on is an index
 * decision, and publishing every column invites a caller to sort by one with
 * no index behind it. A name outside the item's shape is a compile error here,
 * so a typo cannot reach the wire as a `400`.
 */
export const sortableBy = <
  Item extends z.ZodObject<z.ZodRawShape>,
  const Keys extends readonly [SortableKeys<Item["shape"]>, ...SortableKeys<Item["shape"]>[]],
>(
  _item: Item,
  keys: Keys,
): Keys => keys;

export type SortOptions<Keys extends readonly string[]> = {
  /** The keys this listing may be sorted on, from {@link sortableBy}. */
  readonly sortableBy: Keys;
  /** The sort served when a caller names none. Required: an implicit default is a listing sorted by something nobody chose. */
  readonly defaultSort: Sort<Keys[number]>;
};

const runsInOneDirection = (
  { after, before }: { readonly after?: unknown; readonly before?: unknown },
  // The parameter is annotated rather than inferred: merging a generic shape
  // widens what zod can say about the object, and this rule reads two fields
  // whose presence is all it needs.
): boolean => after === undefined || before === undefined;

const oneDirectionMessage = "a page runs in one direction: pass `after` or `before`, not both";

const pageLimitsShape = (limits: PageLimits) => ({
  limit: z
    .number()
    .int()
    .min(1)
    .max(limits.maxLimit ?? 100)
    // `prefault`, not `default`: a default is handed back unparsed, so a
    // listing whose `defaultLimit` sits above its own ceiling would serve a
    // page larger than it published. The emitted input schema is identical.
    .prefault(limits.defaultLimit ?? 20),
  after: z.string().optional(),
  before: z.string().optional(),
});

const unsortedRequest = <Filters extends ReservedKeysFree>(filters: Filters, limits: PageLimits) =>
  z
    .object(pageLimitsShape(limits))
    .extend(filters)
    .refine(runsInOneDirection, { message: oneDirectionMessage });

const sortedRequest = <
  Filters extends ReservedKeysFree,
  const Keys extends readonly [string, ...string[]],
>(
  filters: Filters,
  options: PageLimits & SortOptions<Keys>,
) =>
  z
    .object({
      ...pageLimitsShape(options),
      sort: z
        .strictObject({ field: z.enum(options.sortableBy), direction: z.enum(["asc", "desc"]) })
        .prefault(options.defaultSort),
    })
    .extend(filters)
    .refine(runsInOneDirection, { message: oneDirectionMessage });

/**
 * The schema of a page input: a bounded `limit`, the two opaque cursors, at
 * most one of them, whatever else this listing filters by, and — for a
 * listing that names {@link SortOptions.sortableBy} — the sort it runs in.
 *
 * The pair is refused by the **schema** rather than by the handler, so the
 * refusal is published in the OpenAPI document and answered as a validation
 * error rather than as application logic. What survives it is still two
 * optional fields; {@link pageRequest} is what turns a parsed input into the
 * one-direction `PageRequest` a port takes.
 *
 * `filters` is required, and `{}` is how a listing says it has none — an
 * absent argument and an empty shape would be the same call spelled two ways.
 * `limit`, `after`, `before` and `sort` are the page's own and cannot be among
 * them: a filter replacing one would silently unbound the limit, re-type a
 * cursor or shadow the sort, so the shape refuses it at the call.
 */
export function pageRequestOf<Filters extends ReservedKeysFree>(
  filters: Filters,
  limits?: PageLimits,
): ReturnType<typeof unsortedRequest<Filters>>;
export function pageRequestOf<
  Filters extends ReservedKeysFree,
  const Keys extends readonly [string, ...string[]],
>(
  filters: Filters,
  options: PageLimits & SortOptions<Keys>,
): ReturnType<typeof sortedRequest<Filters, Keys>>;
export function pageRequestOf<
  Filters extends ReservedKeysFree,
  const Keys extends readonly [string, ...string[]] = never,
>(filters: Filters, options: PageLimits & Partial<SortOptions<Keys>> = {}) {
  const { sortableBy: keys, defaultSort } = options;
  // Two full schemas, not one shape merged by a runtime branch: a ternary
  // spread into `z.object` types as a union for every call, sorted or not.
  return keys === undefined || defaultSort === undefined
    ? unsortedRequest(filters, options)
    : sortedRequest(filters, { ...options, sortableBy: keys, defaultSort });
}
