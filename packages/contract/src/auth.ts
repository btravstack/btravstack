// Never exported as a value, so the mark cannot be applied by accident and
// cannot be written literally. It is not unforgeable: `Authenticated<T, R>` is
// exported (`@btravstack/http` needs it), so a deliberate
// `node as unknown as Authenticated<typeof node, [{ user: [] }]>` types as
// protected while the registry stays empty. Exporting the symbol would drop
// the cast — and would also cost every consumer an annotation:
// an inferred exported type that references an inaccessible unique symbol is
// TS2527, which is why `@btravstack/http` hands back ONE nameable object.
declare const PRINCIPAL: unique symbol;

/**
 * One OpenAPI security requirement: a scheme, and the scopes it must grant.
 * A requirement names ONE scheme — this package does not model OpenAPI's
 * AND-within-a-requirement, which would put a record rather than an identity
 * on the handler. See the design spec.
 */
export type Requirement = Readonly<Record<string, readonly string[]>>;

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
// The key names `requirements`, not `marked`: a copy expecting the old
// `WeakSet` would call `.has` on a `WeakMap` and get `true`, which is
// accidentally correct and not worth relying on. Under this key a mismatched
// copy reads unmarked and fails closed.
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
  <const R extends Requirements>(...requirements: R) =>
  <T extends object>(node: T): Authenticated<T, R> => {
    marked.set(node, requirements);
    return node as Authenticated<T, R>;
  };

/**
 * What this exact node requires, or `undefined` when nobody marked it.
 * Ancestry is the caller's to carry — `@btravstack/http`'s `routerOf` walks
 * the tree and passes the nearest mark down.
 */
export const isAuthenticated = (node: object): Requirements | undefined => marked.get(node);
