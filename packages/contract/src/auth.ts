// Never exported as a value, so the mark cannot be applied by accident. Not
// unforgeable, though: `Authenticated<T, R>` is exported, so a deliberate
// double cast types as protected while the registry stays empty. Exporting the
// symbol would drop even that cast.
declare const PRINCIPAL: unique symbol;

/**
 * One OpenAPI security requirement: a scheme, and the scopes it must grant.
 *
 * The CARRIER — what a marked node holds and `isAuthenticated` reads back — so
 * it says nothing about arity. `OneScheme` below is what refuses a second key.
 */
export type Requirement = Readonly<Record<string, readonly string[]>>;

// The standard distribute-then-compare-back union test; do not "simplify" it to
// `K extends U`.
type SeveralKeys<K, U = K> = K extends U ? ([U] extends [K] ? false : true) : never;

/**
 * A requirement naming two schemes is OpenAPI's AND, and nothing here models it:
 * `@btravstack/http-server` takes the first entry that satisfies, which is OR — so a
 * two-key requirement copied out of an OpenAPI document would execute as a
 * WEAKER rule than the one it states. Refused at the mark instead.
 */
export type OneScheme<Q> = SeveralKeys<keyof Q> extends false ? Q : never;

/** Requirements are ORed, in order: the first one a caller satisfies wins. */
export type Requirements = readonly Requirement[];

/** A contract node whose procedures require an authenticated caller. */
export type Authenticated<T, R extends Requirements> = T & { readonly [PRINCIPAL]: R };

/** The marker's key, so a consumer's mapped type can `Exclude` it from `keyof`. */
export type PrincipalKey = typeof PRINCIPAL;

/** Whether this exact node carries the marker. */
export type IsMarked<T> = T extends { readonly [PRINCIPAL]: Requirements } ? true : false;

/** What this exact node requires, or `never` when it is unmarked. */
export type RequirementsOf<T> = T extends { readonly [PRINCIPAL]: infer R extends Requirements }
  ? R
  : never;

// On `globalThis`, not module-private: two copies each with their own map read
// every node the other marked as unmarked, and a protected route serves open.
// The key names `requirements`, not `marked`, so a copy expecting the old
// `WeakSet` reads unmarked and fails closed rather than calling `.has` on a
// `WeakMap` and getting an accidentally-correct `true`.
const KEY: unique symbol = Symbol.for("@btravstack/contract/requirements") as never;
const store = globalThis as unknown as { [KEY]?: WeakMap<object, Requirements> };
const marked = (store[KEY] ??= new WeakMap<object, Requirements>());

/**
 * Marks a contract node as requiring an authenticated caller, with OpenAPI's
 * own requirement shape — a scheme and the scopes it must grant, ORed in the
 * order given.
 *
 * ```ts
 * export const contract = {
 *   orders: authenticated({ user: [] })({ place, find }),
 *   exports: authenticated({ user: ["orders:export"] }, { service: [] })(csvProcedure),
 * };
 * ```
 *
 * Applied to a record it is the default for every procedure beneath it;
 * applied to a procedure it replaces that default for itself. Nearest mark
 * wins. Returns the node unchanged and applies after a builder chain, never
 * inside one. See `packages/contract/CLAUDE.md`.
 */
export const authenticated =
  <const R extends Requirements & { readonly [I in keyof R]: OneScheme<R[I]> }>(
    ...requirements: R
  ) =>
  <T extends object>(node: T): Authenticated<T, R> => {
    marked.set(node, requirements);
    return node as Authenticated<T, R>;
  };

/**
 * What this exact node requires, or `undefined` when nobody marked it.
 * Ancestry is the caller's to carry — `@btravstack/http-server`'s `routerOf` walks
 * the tree and passes the nearest mark down.
 */
export const isAuthenticated = (node: object): Requirements | undefined => marked.get(node);
