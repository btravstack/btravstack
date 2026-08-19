/**
 * The phantom key the marker occupies. Declared, never defined: it exists only
 * in the type system, so a marked node carries no runtime property and there is
 * nothing for oRPC's `implement()` to walk as a procedure. It is never exported
 * as a value either — a nameable brand could be hand-written onto a contract
 * without the corresponding registry entry, which types as protected and runs
 * unmarked: no authenticator demanded, and a handler reading a principal
 * nothing ever injected.
 */
declare const PRINCIPAL: unique symbol;

/** A contract node whose procedures require an authenticated principal. */
export type Authenticated<T> = T & { readonly [PRINCIPAL]: true };

/** The marker's key, so a consumer's mapped type can `Exclude` it from `keyof`. */
export type PrincipalKey = typeof PRINCIPAL;

/** Whether this exact node carries the marker — a yes/no, not a type. */
export type IsMarked<T> = T extends { readonly [PRINCIPAL]: true } ? true : false;

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
 * Marks a contract node as requiring an authenticated caller.
 *
 * ```ts
 * export const contract = {
 *   orders: authenticated({ place, find }),
 *   customers: { find, quote: authenticated(oc.input(…).output(…)) },
 * };
 * ```
 *
 * A marked record protects every procedure beneath it; a marked procedure
 * protects itself. Applied AFTER a builder chain is finished, never inside
 * one, so nothing about oRPC's builders has to preserve it.
 *
 * The contract says **whether** a route is protected and nothing about who the
 * caller is: no principal type is named here, so nothing about the server's
 * identity reaches a client. What the principal actually is, is the
 * application's `httpAuth<Identity>()` to say.
 */
export const authenticated = <T extends object>(node: T): Authenticated<T> => {
  marked.add(node);
  return node as Authenticated<T>;
};

/** Whether this exact node was marked. Ancestry is the caller's to carry. */
export const isAuthenticated = (node: object): boolean => marked.has(node);

// ponytail: opt-in by construction — an unmarked node is public, and forgetting
// the marker fails nothing. Deny-by-default is three lines away and needs no
// redesign: mark the contract root and add `public(node)` that deletes it from
// the set. Add it the first time a route ships unprotected by accident.
