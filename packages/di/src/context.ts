import type { PortInstance, ServiceOf } from "./port.js";

// The only thing this module does with a port at run time is read `portId`, so
// the plumbing is typed against this rather than `AnyPort`, which a concrete
// port class is not assignable to. A constructor intersection rather than a
// plain record, so it still overlaps `get`'s `abstract new () => S` parameter.
// `many?: true` is the same runtime discriminant `port.ts`'s `AnyPort` carries,
// added here so `unsafeAddAll` can tell a set port's members from an ordinary
// port's single service without importing `AnyPort` itself.
type PortLike = {
  readonly portId: string;
  readonly many?: true;
} & (abstract new () => unknown);

/**
 * `_R` is LOAD-BEARING. `in R` only asserts contravariance, and `get` cannot
 * carry the check on its own — `R` appears there solely as the bound of `get`'s
 * own type parameter, which is not independently contravariant. Remove the
 * phantom field, or make it optional, and `Context` measures as bivariant:
 * `Context<Database>` flows where `Context<Database | Logger>` is required, with
 * no signal at the use site.
 */
export type Context<in R> = {
  readonly _R: (r: R) => void;
  // `S extends R` over a naked `abstract new () => S`, never a
  // `P extends AnyPort` filtered by a conditional: the conditional form leaves
  // `P` unresolved and makes every `get` call fail to compile, valid or not.
  readonly get: <S extends R>(port: abstract new () => S) => ServiceOf<S>;
};

// Off the Context object itself, so nothing but this module can reach the
// backing map — `get` is the only public way in.
const entries = new WeakMap<object, ReadonlyMap<string, unknown>>();

const make = (services: ReadonlyMap<string, unknown>): Context<never> => {
  const ctx = {
    // A phantom variance marker: it exists so `Context<in R>` is contravariant
    // in `R`, is never callable, and so no test can reach it. Ignored rather
    // than met, because the alternative is a weaker gate on the container.
    /* v8 ignore next */
    _R: () => {},
    get: (port: PortLike) => {
      // Membership, never `=== undefined`: a port's service may itself be
      // `undefined`, and that is a registered value, not a missing one.
      if (!services.has(port.portId)) {
        // A set port nobody contributed to is empty, not missing: `plan` never
        // registers a port with no providers, so this is the only place the
        // distinction can be made, and contributing nothing is what a starter
        // an application did not compose legitimately does.
        if (port.many === true) return [];
        // Unreachable through the public API, so a bug in this package rather
        // than a modeled error — thrown, which unthrown turns into a defect.
        // oxlint-disable-next-line unthrown/no-throw
        throw new Error(`[di] no service registered for port ${port.portId}`);
      }
      return services.get(port.portId);
    },
  } as unknown as Context<never>;
  entries.set(ctx, services);
  return ctx;
};

export const Context = {
  empty: (): Context<never> => make(new Map()),
};

/** Internal: used only by the build pipeline. Not exported from the package index. */
export const unsafeAdd = <R>(
  ctx: Context<R>,
  port: PortLike,
  service: unknown,
): Context<R | PortInstance<string, unknown>> => {
  const next = new Map<string, unknown>([
    ...(entries.get(ctx) ?? new Map<string, unknown>()),
    [port.portId, service],
  ]);
  return make(next) as never;
};

/**
 * Internal: the `portId`s a context already carries, so `plan` can tell a
 * dependency supplied from OUTSIDE the module tree (a `forkScope` seed) from one
 * nothing supplies at all. Exposes which keys exist, never a service.
 */
export const unsafeKeys = (ctx: Context<never>): ReadonlySet<string> =>
  new Set(entries.get(ctx)?.keys() ?? []);

/**
 * Internal: used only by `build.ts`'s `run`, folding one dependency-ordered
 * level's constructed results into `ctx`. An ordinary port's single service
 * is added directly; a set port's members (`port.many === true`) are
 * gathered into one array first, since `Context.get` on a set port must
 * yield every contribution, not just the last one added.
 *
 * A set port's members can land across more than one level — a
 * dependency-free member is ready earlier than a sibling that depends on
 * something else — so each group is appended to whatever array an *earlier*
 * level already registered for that port (`[]` the first time), never
 * overwritten. That is also what lets a later level's consumer, which
 * `build.ts`'s `plan` schedules only once every member of a port it depends
 * on has been placed, see every contribution built so far.
 */
export const unsafeAddAll = (
  ctx: Context<never>,
  built: readonly (readonly [PortLike, unknown])[],
): Context<never> => {
  const next = new Map(entries.get(ctx));
  for (const [port, service] of built) {
    const members = (): unknown[] => (next.get(port.portId) as unknown[] | undefined) ?? [];
    next.set(port.portId, port.many === true ? [...members(), service] : service);
  }
  return make(next);
};
