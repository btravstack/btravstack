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

export type AnyPort = {
  readonly portId: string;
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
export class Scope extends Port("@di/Scope")<never> {}

/**
 * A `function` declaration, not a `const`, specifically so it hoists: `Scope`
 * above calls it at module-evaluation time.
 */
export function Port<const Id extends string>(id: Id): PortClass<Id> {
  warnOnDuplicateId(id);
  // A class, not a plain object: `extends Port("X")<Shape>` needs a construct
  // signature, and only a class expression provides one.
  // oxlint-disable-next-line typescript/no-extraneous-class max-classes-per-file
  return class {
    static readonly portId = id;
  } as unknown as PortClass<Id>;
}
