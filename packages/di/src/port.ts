declare const ID: unique symbol;
declare const SERVICE: unique symbol;

/**
 * The type that appears in a Needs / Exports union. Identity is the literal `Id`:
 * two ports declared with different ids have different instance types even when
 * their service shapes are identical.
 */
export type PortInstance<Id extends string, Service> = {
  readonly [ID]: Id;
  readonly [SERVICE]: Service;
};

export type PortClass<Id extends string> = {
  new <Service>(): PortInstance<Id, Service>;
  readonly portId: Id;
};

// `PortClass<Id>` has a *generic* construct signature (`new <Service>(): ...`).
// A concrete port class — `class Logger extends Port("Logger")<Shape> {}` — has a
// concrete constructor once `Shape` is fixed by the heritage clause, so `typeof
// Logger` is not structurally assignable to `PortClass<string>`: it would need to
// accept an explicit `Service` type argument at every call, which a fixed-shape
// constructor cannot do. `AnyPort` instead demands only what a concrete port class
// actually has — a `portId` and a (possibly abstract) no-arg constructor returning
// some `PortInstance` — which every port, generic or concrete, satisfies. `abstract
// new` rather than `new` is what makes a concrete class's constructor assignable
// here at all: a plain `new` signature is invariant in "can this be called with
// `new`", so a concrete class needs the weaker `abstract new` target.
// `any` is the only bound that accepts every concrete port as a constraint; a
// narrower one would reject ports whose service shape is itself generic. Kept
// as its own alias so the disable comment survives reformatting — inlined into
// `AnyPort` below, oxfmt wraps the type across lines and moves `any` off the
// line the comment targets.
// oxlint-disable-next-line typescript/no-explicit-any
type AnyPortInstance = PortInstance<string, any>;

export type AnyPort = {
  readonly portId: string;
} & (abstract new () => AnyPortInstance);

/**
 * A concrete port class with `Id` and `Service` fixed — what a helper that
 * hands a port to a caller (`Config.provider("RelayConfig")(schema)`, which
 * mints one; a starter's `HttpRouter(contract)(deps, arm)`, which targets its
 * own fixed one) returns as the type of `provider.port`. A class expression
 * (`class extends Port(id)<S> {}`) has an anonymous type declaration emit
 * cannot name across packages, and a `Port(id)` left generic and typed per
 * contract has none of its own; this is the nameable spelling of both.
 */
export type PortClassOf<Id extends string, Service> = {
  readonly portId: Id;
  new (): PortInstance<Id, Service>;
};

/** Recovers a service shape from either the instance type or the class. */
export type ServiceOf<T> =
  T extends PortInstance<string, infer S>
    ? S
    : T extends abstract new () => PortInstance<string, infer S>
      ? S
      : never;

const seen = new Set<string>();

/**
 * Two distinct port classes sharing an id are distinct types but the same runtime
 * key, so one would silently read the other's service. That is a declaration bug,
 * not a modeled failure, so it warns once per id in development and is folded out
 * of production builds by bundler define-replacement.
 */
function warnOnDuplicateId(id: string): void {
  if (process.env["NODE_ENV"] === "production") return;
  if (seen.has(id)) {
    console.warn(`[di] duplicate port id ${JSON.stringify(id)} — one will shadow the other`);
    return;
  }
  seen.add(id);
}

/**
 * A phantom requirement, not a real service — its shape is `never` because
 * nothing ever constructs one or reads it out of a `Context`. A resourceful
 * provider (the `acquire`/`release` qualification arm, `provider.ts`) adds
 * `Scope` to its `Needs`, so `Module.build` — which demands `Needs` be
 * `never` — refuses a graph that still owns an un-discharged resource. Only
 * `Module.scoped` strips `Scope` back out of `Needs` before checking for
 * unmet dependencies, because it is the one entry point that actually opens
 * a `createScope` and guarantees its `close`. Forgetting to route a
 * resourceful module through `Module.scoped` is a compile error, not a
 * runtime leak.
 *
 * `Scope` being *providable* — `Provider(Scope)({ value: ... })` — is a
 * separate hazard from being unmet, and is deliberately **not** blocked by
 * the type system: a generic type-level guard keyed on `P`'s id (tried
 * first) turned out to be simultaneously bypassable (any `const widened:
 * AnyPort = Scope` before the call slips past a conditional that only ever
 * sees the widened structural type) and a false positive on ordinary
 * port-generic helpers (`function wrap<P extends AnyPort>(port: P) {
 * return Provider(port) }` couldn't typecheck, since the conditional can't
 * reduce for an unresolved `P`). `build.ts`'s `plan()` instead rejects a
 * provider registered for `Scope`'s `portId` as a `WiringDefect`, the same
 * class of pre-construction wiring bug a dependency cycle or a duplicate
 * provider already is — sound against any type-level alias or widening,
 * because it checks the runtime `portId` string, not a static type.
 */
export class Scope extends Port("@di/Scope")<never> {}

/**
 * A `function` declaration, not a `const`, specifically so it hoists: `Scope`
 * above calls it at module-evaluation time.
 */
export function Port<const Id extends string>(id: Id): PortClass<Id> {
  warnOnDuplicateId(id);
  // A class, not a plain object, is required here: `extends Port("X")<Shape>`
  // needs a construct signature, and only a class expression provides one.
  // Two classes in this file are deliberate: `Scope` above is a concrete port
  // that must live here (see its own doc comment), and this one is the factory
  // `Port()` itself returns.
  // oxlint-disable-next-line typescript/no-extraneous-class max-classes-per-file
  return class {
    static readonly portId = id;
  } as unknown as PortClass<Id>;
}
