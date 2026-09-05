import type { Module, Scope } from "@btravstack/di";

/**
 * A module a unit kind may bind, as the upper bound `httpServer`/`http`
 * constrain their own `Unit` type parameter to. `Module`'s `_exports` channel
 * is contravariant, so `Exports = never` — never `unknown` — is what makes a
 * REAL module's own (necessarily narrower) export type assignable to this
 * bound: `(x: Concrete) => void` is assignable to `(x: never) => void`, not
 * to `(x: unknown) => void`. `@btravstack/testing`'s `TestRuntimeOptions.unit`
 * carries the same bound for the same reason.
 */
export type AnyUnitModule = Module<never, never, unknown>;

/**
 * The needs a bound unit module still owes, or `never` when none is bound.
 * `Scope` is excluded, since nothing can ever provide it — the same exemption
 * `NeedsGate` itself carries. Exported for `http-module.ts`, which types
 * `HttpModule`'s own starter independently of `httpServer`'s return type.
 */
export type UnitNeedsOf<Unit> =
  Unit extends Module<never, never, infer N> ? Exclude<N, Scope> : never;

/** Every kind a unit may be opened under: no credential, or the scheme that resolved one. */
export type Kinds<A> = "anonymous" | (keyof A & string);

/**
 * The module bound per kind. Every member is optional, which makes this a weak
 * type — so a kind the authenticators never declared is refused for having no
 * property in common rather than passing an excess-property check that a type
 * argument would not get.
 */
export type UnitsOf<A> = Partial<Readonly<Record<Kinds<A>, AnyUnitModule>>>;
