import type { PortInstance, ServiceOf } from "./port.js";

// `AnyPort` requires a *generic* construct signature (`new <Service>(): ...`), which
// a concrete port class such as `class Logger extends Port("Logger")<Shape> {}` does
// not have once `Shape` has been fixed by the heritage clause — its constructor is
// concrete, not generic, so it is not structurally assignable to `AnyPort`. The only
// thing this module ever does with a port value at runtime is read `portId`, so the
// internal plumbing is typed against this minimal shape instead of `AnyPort` — kept
// as a constructor intersection (rather than plain `{ readonly portId: string }`) so
// it still overlaps with the public `get` signature's `abstract new () => S` param.
type PortLike = {
  readonly portId: string;
} & (abstract new () => unknown);

/**
 * `_R` is load-bearing, not decoration. `Context` is declared `in R`, but the
 * `in` modifier only *asserts* contravariance — TypeScript still checks the
 * declaration's own structure against it, and `get`'s signature cannot carry
 * that check on its own: `get` is a *generic method* whose `R` appears solely
 * as the bound of its own type parameter (`<S extends R>`), a position that is
 * not independently contravariant in `R`. With `_R` removed — or made
 * optional, which has the same effect on the variance measurement — `Context`
 * measures as bivariant in `R`, and `Context<Database>` starts flowing where a
 * `Context<Database | Logger>` is required with no error at the call site.
 * The phantom field is what puts `R` in a genuine parameter position and makes
 * the `in` annotation something the compiler can actually enforce. Do not
 * remove it, and do not make it optional; there is no signal at the use site
 * if you do. (Ledger note carried over from Task 2.)
 */
export type Context<in R> = {
  readonly _R: (r: R) => void;
  // `S extends R` with the port typed as `abstract new () => S` — rather than a
  // `P extends AnyPort` inferred through `InstanceType<P> extends R ? P : never` —
  // is what the pinned TypeScript 7 compiler can actually solve: S is inferred
  // directly from the naked constructor parameter, then checked against R by
  // ordinary constraint checking. The rejected form left `P` unresolved (it
  // defaulted to the `AnyPort` constraint before the conditional was evaluated),
  // which made every `get` call — valid or not — fail to compile.
  readonly get: <S extends R>(port: abstract new () => S) => ServiceOf<S>;
};

// Declared before `make` so it is initialised by the time `make` first runs. The
// backing map is kept off the Context object itself so nothing but this module can
// reach it — `get` is the only public way in.
const entries = new WeakMap<object, ReadonlyMap<string, unknown>>();

const make = (services: ReadonlyMap<string, unknown>): Context<never> => {
  const ctx = {
    _R: () => {},
    get: (port: PortLike) => {
      const service = services.get(port.portId);
      if (service === undefined) {
        // Unreachable through the public API: `get` only accepts a port in R, and
        // the build pipeline fills every port it claims to provide. Reaching here
        // is a bug in this package, so it is a throw — which unthrown turns into a
        // defect at the nearest combinator — not a modeled error.
        // oxlint-disable-next-line unthrown/no-throw
        throw new Error(`[di] no service registered for port ${port.portId}`);
      }
      return service;
    },
    // `Context` is an opaque public interface backed by a differently-shaped
    // concrete object — `unknown` first is the correct escape hatch here, not a
    // sign the shapes are actually wrong; see the `PortLike` note above for why
    // they cannot be made to overlap directly at the type level.
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
 * Internal: the `portId`s a context already carries. Used only by `build.ts`'s
 * `run`, to tell a dependency that is supplied from *outside* the module tree
 * (the seed context a `forkScope` builds over) from one that nothing supplies
 * at all — the first is legitimate, the second is a wiring bug `plan` raises
 * before any factory runs. Not exported from the package index: `get` remains
 * the only public way to read a context, and this deliberately exposes no
 * services, only which keys exist.
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
