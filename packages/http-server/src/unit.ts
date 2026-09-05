import type { Requirements } from "@btravstack/contract";
import type { AnyPort, Context, Module, PortInstance, Scope, ServiceOf } from "@btravstack/di";

import type { SchemesOf } from "./principal.js";

/**
 * A module a unit kind may bind: the value type of the record that `httpServer`
 * and `http` bind their own `Units` type parameter to. `Module`'s `_exports` channel
 * is contravariant, so `Exports = never` — never `unknown` — is what makes a
 * REAL module's own (necessarily narrower) export type assignable to this
 * bound: `(x: Concrete) => void` is assignable to `(x: never) => void`, not
 * to `(x: unknown) => void`. `@btravstack/testing`'s `TestRuntimeOptions.unit`
 * carries the same bound for the same reason.
 */
export type AnyUnitModule = Module<never, never, unknown>;

/** What a bound unit module exports — the port instances a leaf of that kind may read. */
export type UnitExportsOf<M> = M extends Module<infer X, never, unknown> ? X : never;

/**
 * The needs a bound unit module still owes, or `never` when none is bound.
 * `Scope` is excluded, since nothing can ever provide it — the same exemption
 * `NeedsGate` itself carries. Exported for `http-module.ts`, which types
 * `HttpModule`'s own starter independently of `httpServer`'s return type.
 */
export type UnitNeedsOf<Unit> =
  Unit extends Module<never, never, infer N> ? Exclude<N, Scope> : never;

/**
 * Any scheme's principal port, as it appears in a needs union. The seed is what
 * discharges it — a unit module naming one owes the composition root nothing —
 * so it is subtracted from what a bound kind's module still needs.
 */
export type PrincipalInstance = PortInstance<`HttpPrincipal:${string}`, unknown>;

/**
 * What a record of bound kinds still owes the composition root: every bound
 * module's own unmet needs, less the principal the fork seeds.
 */
export type UnitsNeedsOf<Units> =
  Units extends Readonly<Record<string, unknown>>
    ? Exclude<UnitNeedsOf<Units[keyof Units]>, PrincipalInstance>
    : never;

/** Every kind a unit may be opened under: no credential, or the scheme that resolved one. */
export type Kinds<A> = "anonymous" | (keyof A & string);

/**
 * The module bound per kind. Every member is optional, which makes this a weak
 * type — so a kind the authenticators never declared is refused for having no
 * property in common rather than passing an excess-property check that a type
 * argument would not get.
 */
export type UnitsOf<A> = Partial<Readonly<Record<Kinds<A>, AnyUnitModule>>>;

/** The kind a leaf's effective requirements select: `anonymous` when unmarked, else its schemes. */
export type KindOf<R extends Requirements> = [R] extends [never] ? "anonymous" : SchemesOf<R>;

/**
 * The module kind `K` forks: the one it bound, or `anonymous`'s when it bound
 * none — the fallback `unitScope` applies at runtime, restated here so the two
 * cannot part.
 */
type ModuleOf<Units, K extends string> = [NonNullable<Units[K & keyof Units]>] extends [never]
  ? NonNullable<Units["anonymous" & keyof Units]>
  : NonNullable<Units[K & keyof Units]>;

/** True when port instance `P` is exported by the module of EVERY kind in `K`. */
export type InAll<P, Units, K extends string> = [K] extends [never]
  ? false
  : (
        K extends unknown ? (P extends UnitExportsOf<ModuleOf<Units, K>> ? true : false) : never
      ) extends true
    ? true
    : false;

/**
 * The declared `unit:` record, keeping only the ports the leaf's kind(s) can
 * provide. A name the kind's module does not export is not a property, so
 * reading it is TypeScript's own "property does not exist".
 */
export type UnitFor<U extends Readonly<Record<string, AnyPort>>, Units, K extends string> = {
  readonly [
    N in keyof U as InAll<InstanceType<U[N]>, Units, K> extends true ? N : never
  ]: ServiceOf<InstanceType<U[N]>>;
};

/**
 * The declared record, as a getter per name resolved on read out of the fork:
 * `UnitFor` hides the names the forked kind cannot provide, so resolving them
 * eagerly would defect on a port no leaf of this kind can name. Neither
 * writable nor configurable — a handler reads what the fork holds, and cannot
 * reshape the record under the next one. Built once per unit, by both
 * answerers: `unit-scope.ts` is oRPC's, `htmx.ts` the fragments'.
 */
export const unitRecordOf = (
  forked: Context<never>,
  record: Readonly<Record<string, AnyPort>>,
): Readonly<Record<string, unknown>> => {
  const unit: Record<string, unknown> = {};
  for (const [name, port] of Object.entries(record))
    Object.defineProperty(unit, name, {
      enumerable: true,
      get: () => forked.get(port as never),
    });
  return unit;
};
