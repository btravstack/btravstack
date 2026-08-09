declare const ID: unique symbol;
declare const SERVICE: unique symbol;
declare const MANY: unique symbol;

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

/**
 * A set port: several providers may target it, and `Context.get` yields every
 * contribution rather than one service. `Port.many("Id")<Member>` fixes the
 * *member* shape via the same generic-heritage-instantiation trick
 * `PortClass` uses (`class Handlers extends Port.many("Id")<Member> {}`), but
 * the port's own `Service` — what actually lands in a `Context` and what
 * `Context.get` returns — is `readonly Member[]`, not `Member`. The `[MANY]`
 * brand on the instance type exists purely at the type level (no
 * `ManyPortClass` is ever constructed at runtime; ports are phantom tokens,
 * same as `PortClass`) so a member's *own* shape can be recovered from a
 * concrete set-port class via `MemberOf` below, the same way `ServiceOf`
 * recovers an ordinary port's shape from `PortInstance`.
 *
 * The `many: true` *static* field is the actual runtime discriminant —
 * `build.ts`'s `plan`/`constructLevel` read `port.many` off the concrete
 * class object at runtime (inherited from whatever `Port.many` returns, the
 * same way a concrete port's `portId` is inherited), since the `[MANY]`
 * symbol lives only in the (never-instantiated) instance type and cannot be
 * read back at runtime.
 */
export type ManyPortClass<Id extends string> = {
  new <Member>(): PortInstance<Id, readonly Member[]> & { readonly [MANY]: true };
  readonly portId: Id;
  readonly many: true;
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

// `many?: true` is optional, not required, so it stays structurally
// unaffected for every ordinary `PortClass<Id>`-derived port (which never
// declares it) while still letting `build.ts` read `provider.port.many` off
// a value typed only as `AnyPort` — the same reasoning that keeps `Scope`,
// an ordinary port, exempt from the many-port codepath: `Scope.many` is
// `undefined`, not `true`.
export type AnyPort = {
  readonly portId: string;
  readonly many?: true;
} & (abstract new () => AnyPortInstance);

/** Recovers a service shape from either the instance type or the class. */
export type ServiceOf<T> =
  T extends PortInstance<string, infer S>
    ? S
    : T extends abstract new () => PortInstance<string, infer S>
      ? S
      : never;

/**
 * Recovers a set port's *member* shape — the type a `Provider.member` factory
 * actually produces — from `[MANY]`, not from `ServiceOf<T>`'s shape. An
 * earlier version keyed this off "does the service look like an array"
 * (`ServiceOf<T> extends readonly (infer M)[] ? M : never`), which is
 * unsound: an *ordinary* port whose declared service happens to be an array
 * — `class Tags extends Port("Tags")<readonly string[]> {}` — has `many`
 * `undefined` at runtime (`build.ts`'s `plan`/`context.ts`'s `unsafeAddAll`
 * both discriminate on that static field, never on shape), so
 * `Provider.member(Tags)({ value: "a" } )` type-checked under the old
 * definition while landing as a single service at runtime — `ctx.get(Tags)`
 * would return `"a"`, contradicting its own `readonly string[]` type. `[MANY]`
 * is the same brand `ManyPortClass`'s instance type carries and is
 * module-private (declared, not exported, above), so nothing outside this
 * file can forge it onto an ordinary port's instance type; keying `MemberOf`
 * off its presence makes the type-level check agree with the runtime one.
 */
export type MemberOf<T> = T extends { readonly [MANY]: true } & PortInstance<string, infer S>
  ? S extends readonly (infer M)[]
    ? M
    : never
  : T extends abstract new () => { readonly [MANY]: true } & PortInstance<string, infer S>
    ? S extends readonly (infer M)[]
      ? M
      : never
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
export class Scope extends PortDeclaration("@di/Scope")<never> {}

/**
 * Renamed from the brief's plain exported `Port` function: the "operations
 * namespaced on the constructor" convention (`Port.many`, below) needs a
 * value distinct from this one to `Object.assign` the namespace onto —
 * same rationale, and the same fix, as `ModuleDeclaration`/`ProviderDeclaration`
 * elsewhere in this package. Kept as a `function` declaration (not a `const`)
 * specifically so it hoists: `Scope`, above, calls it at module-evaluation
 * time, before the `export const Port = Object.assign(...)` line below has
 * run — a `const` there would still be in its temporal dead zone.
 */
function PortDeclaration<const Id extends string>(id: Id): PortClass<Id> {
  warnOnDuplicateId(id);
  // A class, not a plain object, is required here: `extends Port("X")<Shape>`
  // needs a construct signature, and only a class expression provides one.
  // Two classes in this file are deliberate, not an organisation smell: `Scope`
  // above is a concrete port that must live here (see its own doc comment),
  // and this one is the factory `Port()` itself returns.
  // oxlint-disable-next-line typescript/no-extraneous-class max-classes-per-file
  return class {
    static readonly portId = id;
  } as unknown as PortClass<Id>;
}

/**
 * `Port.many` mirrors `PortDeclaration` exactly, except the returned class
 * also carries a `many: true` static field — the runtime discriminant
 * `build.ts`'s `plan`/`constructLevel` read to decide a port accumulates
 * contributions instead of colliding on the second provider. See
 * `ManyPortClass`'s own doc comment above for why this is a *static* field
 * (readable at runtime off the class) rather than the `[MANY]` brand (a
 * type-level-only marker on the never-instantiated instance type).
 */
export const Port = Object.assign(PortDeclaration, {
  many: <const Id extends string>(id: Id): ManyPortClass<Id> => {
    warnOnDuplicateId(id);
    // oxlint-disable-next-line typescript/no-extraneous-class max-classes-per-file
    return class {
      static readonly portId = id;
      static readonly many = true;
    } as unknown as ManyPortClass<Id>;
  },
});
