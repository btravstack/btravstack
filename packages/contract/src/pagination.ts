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
