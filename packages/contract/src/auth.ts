/**
 * The phantom key the marker occupies. Declared, never defined: it exists only
 * in the type system, so a marked node carries no runtime property and there is
 * nothing for oRPC's `implement()` to walk as a procedure.
 */
declare const PRINCIPAL: unique symbol;

/** A contract node whose procedures require an authenticated principal of type `P`. */
export type Authenticated<T, P> = T & { readonly [PRINCIPAL]: P };

/** The marker's key, so a consumer's mapped type can `Exclude` it from `keyof`. */
export type PrincipalKey = typeof PRINCIPAL;

/** The principal a node was marked with, or `never` when it carries no marker. */
export type PrincipalOf<T> = T extends { readonly [PRINCIPAL]: infer P } ? P : never;

// Identity, not a property: a marked node must stay `===` what the contract
// declared, so `implement()` walks it unchanged and a consumer can still index
// the fragment out of the contract it lives in.
//
// The registry hangs off `globalThis`, not off this module, because identity is
// what the marker IS: two copies of this package with a private set each read
// every node the other marked as unmarked, so `hasMarked` answers false, the
// router declares no authenticator and the route is served OPEN. One shared
// registry makes the second copy a compile error (the `unique symbol` differs)
// rather than a silent hole.
const registry: unique symbol = Symbol.for("@btravstack/contract/marked");
const store = globalThis as unknown as { [registry]?: WeakSet<object> };
const marked = (store[registry] ??= new WeakSet<object>());

/**
 * Mints the combinator for one contract's principal type.
 *
 * ```ts
 * export type Principal = { readonly userId: string };
 * const { authenticated } = auth<Principal>();
 *
 * export const contract = {
 *   orders: authenticated({ place, find }),
 *   customers: { find, quote: authenticated(oc.input(…).output(…)) },
 * };
 * ```
 *
 * A marked record protects every procedure beneath it; a marked procedure
 * protects itself. Applied AFTER a builder chain is finished, never inside
 * one, so nothing about oRPC's builders has to preserve it.
 */
export const auth = <P>(): {
  readonly authenticated: <T extends object>(node: T) => Authenticated<T, P>;
} => ({
  authenticated: <T extends object>(node: T): Authenticated<T, P> => {
    marked.add(node);
    return node as Authenticated<T, P>;
  },
});

/** Whether this exact node was marked. Ancestry is the caller's to carry. */
export const isAuthenticated = (node: object): boolean => marked.has(node);

// ponytail: opt-in by construction — an unmarked node is public, and forgetting
// the marker fails nothing. Deny-by-default is three lines away and needs no
// redesign: mark the contract root and add `public(node)` that deletes it from
// the set. Add it the first time a route ships unprotected by accident.
