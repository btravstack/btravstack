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
 * One sort key and the direction it runs in.
 *
 * Both halves are required, so a field without a direction is
 * unrepresentable. One key, not a list: a cursor has to encode every ordering
 * column, and each extra column is another value the seek and the token must
 * agree about.
 */
export type Sort<F extends string = string> = {
  readonly field: F;
  readonly direction: "asc" | "desc";
};

/**
 * What a caller asks for: a size, at most one cursor, and — for a listing that
 * declares one — the sort it runs in.
 *
 * `after` and `before` are the opaque cursors a previous page handed back, and
 * they are **mutually exclusive in the type**: a page runs in one direction,
 * and "after X and before Y" is a range query wearing a page's clothes. A union
 * is what makes that unrepresentable rather than merely documented.
 *
 * `F` is the listing's own sortable vocabulary. There are two states and no
 * third: a listing that names one always has a sort, a listing that names none
 * can never carry one — which is what lets a cursor's arity be known from the
 * request alone.
 */
export type PageRequest<F extends string = never> = (
  | { readonly limit: number; readonly after?: string | undefined; readonly before?: never }
  | { readonly limit: number; readonly before?: string | undefined; readonly after?: never }
) &
  ([F] extends [never] ? { readonly sort?: never } : { readonly sort: Sort<F> });

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
  readonly sort?: Sort | undefined;
};

/**
 * A validated page input, narrowed into the one-direction {@link PageRequest} a
 * port takes, carrying any filters alongside it untouched.
 *
 * `before` wins when both are somehow present. That precedence is unreachable
 * through `pageRequestOf`, whose schema refuses the pair — it exists so this
 * function is total rather than partial, not as a policy a caller should rely
 * on.
 *
 * A sort stays a sort: it is a field of the query like any filter, so it rides
 * through untouched and the result is the {@link PageRequest} of that listing's
 * own vocabulary rather than of none.
 */
export const pageRequest = <Q extends PageQuery>(
  query: Q,
): (Q extends { readonly sort: Sort<infer F> } ? PageRequest<F> : PageRequest) &
  Omit<Q, "after" | "before"> => {
  const { after, before, ...filters } = query;
  // `Q` resolves at the call, and nothing is assignable to a deferred conditional.
  return {
    ...filters,
    ...(before !== undefined ? { before } : after !== undefined ? { after } : {}),
  } as never;
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
 * A keyset for a sorted listing, or the refusal of a cursor that was issued
 * under a different one.
 *
 * `cursor` carries BOTH values a sorted seek needs — the sort key's and the
 * tiebreak's — because a store queried with only the first seeks on one column
 * and silently skips every row that ties on it.
 */
export type SortedKeyset<F extends string> = {
  readonly resumable: true;
  readonly take: number;
  readonly backward: boolean;
  readonly sort: Sort<F>;
  readonly cursor: readonly [sortValue: string, key: string] | undefined;
  readonly page: <T, U = T>(
    rows: readonly T[],
    cursorOf: (row: T) => readonly [sortValue: string, key: string],
    item?: (row: T) => U,
  ) => Page<U>;
};

/** A cursor that cannot be honoured under the sort it arrived with. */
export type CursorRefused = { readonly resumable: false; readonly cursor: string };

const SEPARATOR = "|";

const headOf = (sort: Sort): string => `${encodeURIComponent(sort.field)}:${sort.direction}`;

const partsOf = (cursor: string, sort: Sort): readonly [string, string] | undefined => {
  const parts = cursor.split(SEPARATOR);
  const [head, sortValue, key] = parts;
  return parts.length === 3 && head === headOf(sort) && sortValue !== undefined && key !== undefined
    ? [decodeURIComponent(sortValue), decodeURIComponent(key)]
    : undefined;
};

const fold = <T, U>(
  rows: readonly T[],
  limit: number,
  backward: boolean,
  resumed: boolean,
  item: (row: T) => U,
  cursorOf: (row: T) => string,
): Page<U> => {
  const more = rows.length > limit;
  const trimmed = more ? rows.slice(0, limit) : rows;
  const seen = backward ? [...trimmed].reverse() : trimmed;
  const edge = (row: T | undefined) => (row === undefined ? null : cursorOf(row));
  return page(seen.map(item), {
    previous: (backward ? more : resumed) ? edge(seen[0]) : null,
    next: backward || more ? edge(seen.at(-1)) : null,
  });
};

const unsortedKeyset = (limit: number, backward: boolean, cursor: string | undefined): Keyset => ({
  take: limit + 1,
  backward,
  cursor,
  page: (rows, cursorOf, item = (row) => row as never) =>
    fold(rows, limit, backward, cursor !== undefined && !backward, item, cursorOf),
});

const sortedKeyset = (
  limit: number,
  backward: boolean,
  sort: Sort,
  cursor: readonly [sortValue: string, key: string] | undefined,
): SortedKeyset<string> => ({
  resumable: true,
  take: limit + 1,
  backward,
  sort,
  cursor,
  page: (rows, cursorOf, item = (row) => row as never) =>
    fold(rows, limit, backward, cursor !== undefined && !backward, item, (row) =>
      [headOf(sort), ...cursorOf(row).map((part) => encodeURIComponent(part))].join(SEPARATOR),
    ),
});

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
 * **A sorted request answers a union the caller must branch on.** The cursor a
 * sorted listing mints carries the sort it was issued under, so one replayed
 * under a different field — or the same field in the other direction — is
 * REFUSED rather than served from the wrong side.
 *
 * @example
 * ```ts
 * const keys = keyset(request);
 * const rows = await store.seek(keys.cursor, keys.backward).take(keys.take);
 * return keys.page(rows, (row) => String(row.id));
 * ```
 */
export function keyset(request: PageRequest): Keyset;
export function keyset<F extends string>(request: PageRequest<F>): SortedKeyset<F> | CursorRefused;
export function keyset(
  request: PageRequest | PageRequest<string>,
): Keyset | SortedKeyset<string> | CursorRefused {
  const { limit } = request;
  const backward = request.before !== undefined;
  const given = request.before ?? request.after;
  const { sort } = request;
  if (sort === undefined) return unsortedKeyset(limit, backward, given);
  const parts = given === undefined ? undefined : partsOf(given, sort);
  if (given !== undefined && parts === undefined) return { resumable: false, cursor: given };
  return sortedKeyset(limit, backward, sort, parts);
}
