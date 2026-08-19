// Never exported as a value: a nameable brand could be hand-written onto a
// contract without the matching registry entry, which types as protected and
// runs unmarked — no authenticator demanded, and a handler reading a principal
// nothing injected.
declare const PRINCIPAL: unique symbol;

/** A contract node whose procedures require an authenticated caller. */
export type Authenticated<T> = T & { readonly [PRINCIPAL]: true };

/** The marker's key, so a consumer's mapped type can `Exclude` it from `keyof`. */
export type PrincipalKey = typeof PRINCIPAL;

/** Whether this exact node carries the marker. */
export type IsMarked<T> = T extends { readonly [PRINCIPAL]: true } ? true : false;

// On `globalThis`, not module-private: two copies each with their own set read
// every node the other marked as unmarked, and a protected route serves open.
const KEY: unique symbol = Symbol.for("@btravstack/contract/marked");
const store = globalThis as unknown as { [KEY]?: WeakSet<object> };
const marked = (store[KEY] ??= new WeakSet<object>());

/**
 * Marks a contract node as requiring an authenticated caller — a record
 * protects every procedure beneath it, a procedure protects itself.
 *
 * ```ts
 * export const contract = {
 *   orders: authenticated({ place, find }),
 *   customers: { find, quote: authenticated(oc.input(…).output(…)) },
 * };
 * ```
 *
 * Returns the node unchanged and applies after a builder chain, never inside
 * one. See `packages/contract/CLAUDE.md`.
 */
export const authenticated = <T extends object>(node: T): Authenticated<T> => {
  marked.add(node);
  return node as Authenticated<T>;
};

/** Whether this exact node was marked. Ancestry is the caller's to carry. */
export const isAuthenticated = (node: object): boolean => marked.has(node);

// ponytail: opt-in by construction — an unmarked node is public, and forgetting
// the marker fails nothing. Deny-by-default is three lines away: mark the root
// and add `public(node)` that deletes it from the set.
