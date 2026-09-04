import { z } from "zod";

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
 * What it parses to is `Page<T>` exactly, which `pagination.test-d.ts` pins in
 * both directions: the wire shape and the type a port speaks cannot drift
 * apart.
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
 * The schema of a page input: a bounded `limit`, the two opaque cursors, at
 * most one of them, and whatever else this listing filters by.
 *
 * The pair is refused by the **schema** rather than by the handler, so the
 * refusal is published in the OpenAPI document and answered as a validation
 * error rather than as application logic. What survives it is still two
 * optional fields; {@link pageRequest} is what turns a parsed input into the
 * one-direction `PageRequest` a port takes.
 *
 * `filters` is required, and `{}` is how a listing says it has none — an
 * absent argument and an empty shape would be the same call spelled two ways.
 */
export const pageRequestOf = <Filters extends z.ZodRawShape>(
  filters: Filters,
  limits: PageLimits = {},
) =>
  z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(limits.maxLimit ?? 100)
        .default(limits.defaultLimit ?? 20),
      after: z.string().optional(),
      before: z.string().optional(),
    })
    .extend(filters)
    // The parameter is annotated rather than inferred: merging a generic shape
    // widens what zod can say about the object, and this rule reads two fields
    // whose presence is all it needs.
    .refine(
      ({ after, before }: { readonly after?: unknown; readonly before?: unknown }) =>
        after === undefined || before === undefined,
      { message: "a page runs in one direction: pass `after` or `before`, not both" },
    );
