import type { PortInstance, ServiceOf } from "./port.js";

// The only thing this module does with a port at run time is read `portId`, so
// the plumbing is typed against this rather than `AnyPort`, which a concrete
// port class is not assignable to. A constructor intersection rather than a
// plain record, so it still overlaps `get`'s `abstract new () => S` parameter.
type PortLike = {
  readonly portId: string;
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
    _R: () => {},
    get: (port: PortLike) => {
      const service = services.get(port.portId);
      if (service === undefined) {
        // Unreachable through the public API, so a bug in this package rather
        // than a modeled error — thrown, which unthrown turns into a defect.
        // oxlint-disable-next-line unthrown/no-throw
        throw new Error(`[di] no service registered for port ${port.portId}`);
      }
      return service;
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
 * level's constructed results into `ctx`.
 */
export const unsafeAddAll = (
  ctx: Context<never>,
  built: readonly (readonly [PortLike, unknown])[],
): Context<never> =>
  built.reduce<Context<never>>(
    (c, [port, service]) => unsafeAdd(c, port, service) as Context<never>,
    ctx,
  );
