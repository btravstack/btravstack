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
 * MEMBER shape, but the port's own service — what lands in a `Context` — is
 * `readonly Member[]`.
 *
 * `many: true` is the runtime discriminant `build.ts` reads off the class;
 * the `[MANY]` brand is its type-level twin, which is what lets `MemberOf`
 * recover a member's shape from a concrete set-port class.
 */
export type ManyPortClass<Id extends string> = {
  new <Member>(): PortInstance<Id, readonly Member[]> & { readonly [MANY]: true };
  readonly portId: Id;
  readonly many: true;
};

// `AnyPort` demands only what a concrete port class has, since `typeof Logger`
// is not assignable to `PortClass<string>`'s generic construct signature.
// `abstract new` rather than `new` is what makes a concrete class's constructor
// assignable at all — a plain `new` signature is invariant.
//
// `any` is the only bound that accepts every concrete port; a narrower one
// rejects ports whose service shape is itself generic. Its own alias so the
// disable survives reformatting: inlined, oxfmt moves `any` off this line.
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

/**
 * A concrete port class with `Id` and `Service` fixed — the type of
 * `provider.port` for a helper that mints or targets a port the caller never
 * spells. A class expression's type is anonymous and declaration emit cannot
 * name it across packages; this is the nameable spelling.
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

/**
 * Recovers a set port's *member* shape — the type a `Provider.member` factory
 * actually produces — from `[MANY]`, not from `ServiceOf<T>`'s shape. An
 * earlier version keyed this off "does the service look like an array"
 * (`ServiceOf<T> extends readonly (infer M)[] ? M : never`), which is
 * unsound: an *ordinary* port whose declared service happens to be an array
 * — `class Tags extends Port("Tags")<readonly string[]> {}` — has `many`
 * `undefined` at runtime (`build.ts`'s `plan`/`context.ts`'s `unsafeAddAll`
 * both discriminate on that static field, never on shape), so
 * `Provider.member(Tags)({ inject: {}, value: "a" })` type-checked under the old
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
 * A phantom requirement, not a real service: nothing constructs one or reads it
 * out of a `Context`. A resourceful provider adds `Scope` to its `Needs`, so
 * `Module.build` refuses a graph that still owns an un-discharged resource and
 * only `Module.scoped` — which opens one — strips it back out.
 *
 * Whether `Scope` can be PROVIDED is a separate hazard, checked at run time by
 * `build.ts`'s `plan` rather than in the types. A type-level guard keyed on the
 * id was tried and was both bypassable (a widening to `AnyPort` before the call
 * slips past it) and a false positive on any port-generic helper, since the
 * conditional cannot reduce for an unresolved `P`.
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
  // A class, not a plain object: `extends Port("X")<Shape>` needs a construct
  // signature, and only a class expression provides one.
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
