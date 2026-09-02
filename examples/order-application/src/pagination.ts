import { TaggedError } from "unthrown";

/**
 * One page of a listing, in the application's own words.
 *
 * Declared **once** for the whole layer rather than per repository, and
 * deliberately not by the framework: `@unthrown/prisma`'s `tryPaginate` does
 * the cursor arithmetic in the adapter, and its
 * `[rows, { hasNextPage, endCursor, … }]` shape stops there. A port that spoke
 * that shape would name a persistence library in the application's vocabulary,
 * which is the same mistake as a port naming a transaction.
 *
 * **A flag and its cursor are one fact, spelled once.** `hasNextPage: true`
 * carries the `nextCursor` that continues the listing; `hasNextPage: false` has
 * no `nextCursor` field at all. So "there is more, and nothing to follow it
 * with" — and its twin, a cursor nobody may use — are unrepresentable rather
 * than merely unexpected, and a reader that checks the flag has the cursor in
 * hand, with no null to widen it. `page` is the one constructor, so no caller
 * spells the pairing itself.
 */
export type Page<T> = { readonly items: readonly T[] } & (
  | { readonly hasPreviousPage: true; readonly previousCursor: string }
  | { readonly hasPreviousPage: false; readonly previousCursor?: never }
) &
  (
    | { readonly hasNextPage: true; readonly nextCursor: string }
    | { readonly hasNextPage: false; readonly nextCursor?: never }
  );

/**
 * A page from its items and the cursor on each side, `null` where there is
 * nothing to follow.
 *
 * The flags are DERIVED rather than given: a cursor is what a caller needs to
 * ask for the page on that side, so a side with no cursor is a side it cannot
 * reach — which is what the flags say now. An adapter whose library reports a
 * page that way round (`@unthrown/prisma` answers `hasPreviousPage: true` with
 * a null `startCursor` for an empty page past the end) therefore reports the
 * reachable answer.
 */
export const page = <T>(
  items: readonly T[],
  cursors: { readonly previous: string | null; readonly next: string | null },
): Page<T> => ({
  items,
  ...(cursors.previous === null
    ? { hasPreviousPage: false as const }
    : { hasPreviousPage: true as const, previousCursor: cursors.previous }),
  ...(cursors.next === null
    ? { hasNextPage: false as const }
    : { hasNextPage: true as const, nextCursor: cursors.next }),
});

/**
 * What a caller asks for: a size, and at most one cursor.
 *
 * `after` and `before` are **opaque** strings — the cursors a previous page
 * handed back, which nothing above the adapter may read — and they are
 * **mutually exclusive in the type**, mirroring `@unthrown/prisma`'s own rule:
 * a page runs in one direction, and "after X and before Y" is a range query
 * wearing a page's clothes. A union is what makes that unrepresentable rather
 * than merely documented.
 */
export type PageRequest =
  | { readonly limit: number; readonly after?: string | undefined; readonly before?: never }
  | { readonly limit: number; readonly before?: string | undefined; readonly after?: never };

/**
 * The cursor could not be read.
 *
 * The one modeled failure of a listing, and it is modeled because the cursor is
 * the only part of the query that came from **outside** — a client sending
 * garbage is input you answer with a 400, not a bug. Every other pagination
 * failure is a defect like any other query.
 *
 * It lives in the application layer rather than the domain: a cursor is an
 * artifact of how a listing is served, and the domain has no listings.
 */
export class MalformedCursor extends TaggedError("MalformedCursor")<{
  readonly cursor: string;
}> {}
