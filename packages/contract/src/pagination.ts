/**
 * One page of a listing, in the vocabulary a client and a server share.
 *
 * **A flag and its cursor are one fact, spelled once.** `hasNextPage: true`
 * carries the `nextCursor` that continues the listing; `hasNextPage: false` has
 * no `nextCursor` field at all. So "there is more, and nothing to follow it
 * with" — and its twin, a cursor nobody may use — are unrepresentable rather
 * than merely unexpected, and a reader that checks the flag has the cursor in
 * hand, with no null to widen it.
 *
 * A cursor is an **opaque** string: the server's to mint and to read, the
 * client's to hand back verbatim. Nothing above the adapter that issued one may
 * interpret it.
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
 * reach — which is what the flags say. An adapter whose pagination library
 * reports a page the other way round, a `hasPreviousPage: true` with no cursor
 * to go back with, therefore reports the reachable answer instead.
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
 * `after` and `before` are the opaque cursors a previous page handed back, and
 * they are **mutually exclusive in the type**: a page runs in one direction,
 * and "after X and before Y" is a range query wearing a page's clothes. A union
 * is what makes that unrepresentable rather than merely documented.
 */
export type PageRequest =
  | { readonly limit: number; readonly after?: string | undefined; readonly before?: never }
  | { readonly limit: number; readonly before?: string | undefined; readonly after?: never };

/**
 * The flat shape a validated page input arrives in, before its two cursors have
 * been narrowed to the one direction {@link PageRequest} allows.
 *
 * A schema states "at most one of these" as a rule over two optional fields; a
 * type states it as a union. This is the former, and {@link pageRequest} is the
 * crossing between them.
 */
export type PageQuery = {
  readonly limit: number;
  readonly after?: string | undefined;
  readonly before?: string | undefined;
};

/**
 * A validated page input, narrowed into the one-direction {@link PageRequest} a
 * port takes, carrying any filters alongside it untouched.
 *
 * `before` wins when both are somehow present. That precedence is unreachable
 * through `pageRequestOf`, whose schema refuses the pair — it exists so this
 * function is total rather than partial, not as a policy a caller should rely
 * on.
 */
export const pageRequest = <Q extends PageQuery>(
  query: Q,
): PageRequest & Omit<Q, "after" | "before"> => {
  const { after, before, ...filters } = query;
  return {
    ...filters,
    ...(before !== undefined ? { before } : after !== undefined ? { after } : {}),
  };
};

/**
 * One keyset window: what to ask the store for, and how to fold what comes back.
 *
 * The two halves ride one object because they have to AGREE. `take` is one more
 * row than the page so the extra row answers "is there another page" without a
 * second count query — and `page` subtracts that same row back out. A store
 * queried for `limit` and folded as though it had been queried for `limit + 1`
 * reports the last page as having a next one, forever.
 */
export type Keyset = {
  /** How many rows to ask for: the page, plus one to detect the next. */
  readonly take: number;
  /** Walk descending from the cursor. `before` pages backward; everything else forward. */
  readonly backward: boolean;
  /** The cursor to resume from, whichever side it came from, or `undefined` at the end. */
  readonly cursor: string | undefined;
  /**
   * The rows the store answered — in the order it answered them — folded into a
   * page, with `cursorOf` minting the opaque cursor for a row.
   *
   * `item` is there because **the row a store seeks by is rarely the thing a
   * port hands back**: an adapter pages on a surrogate key and answers domain
   * entities, so the cursor and the item come off the same row by two different
   * routes. It defaults to the row itself.
   */
  readonly page: <T, U = T>(
    rows: readonly T[],
    cursorOf: (row: T) => string,
    item?: (row: T) => U,
  ) => Page<U>;
};

/**
 * The keyset pagination an adapter would otherwise hand-roll: the over-fetch,
 * the direction, the trim, and both cursors.
 *
 * It does not run the query — the store's own seek call is the one thing this
 * tier cannot express, and every store spells it differently. What it owns is
 * the arithmetic around that call, which is identical everywhere and is where
 * the off-by-ones live.
 *
 * **Backward is not forward reversed.** `before` walks the index descending, so
 * the rows arrive newest-first and `page` hands them back ascending — a
 * previous page reads the way the next one does. It also flips which side the
 * extra row proves: paging forward, one more row means there is a page AFTER;
 * paging backward it means there is one BEFORE.
 *
 * A cursor is minted only from a row that is actually on the page, so an empty
 * page carries neither — which is what makes both flags on {@link Page} honest.
 *
 * @example
 * ```ts
 * const keys = keyset(request);
 * const rows = await store.seek(keys.cursor, keys.backward).take(keys.take);
 * return keys.page(rows, (row) => String(row.id));
 * ```
 */
export const keyset = (request: PageRequest): Keyset => {
  const { limit } = request;
  const backward = request.before !== undefined;
  return {
    take: limit + 1,
    backward,
    cursor: request.before ?? request.after,
    page: (rows, cursorOf, item = (row) => row as never) => {
      const more = rows.length > limit;
      const trimmed = more ? rows.slice(0, limit) : rows;
      const seen = backward ? [...trimmed].reverse() : trimmed;
      const edge = (row: (typeof seen)[number] | undefined) =>
        row === undefined ? null : cursorOf(row);
      return page(seen.map(item), {
        previous: (backward ? more : request.after !== undefined) ? edge(seen[0]) : null,
        next: backward || more ? edge(seen.at(-1)) : null,
      });
    },
  };
};
