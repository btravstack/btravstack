import { Ok, fromSafePromise, type AsyncResult } from "unthrown";

import { Context, unsafeAddAll, unsafeKeys } from "./context.js";
import { constructLevel, runStartHooks, type AnyProvider } from "./lifecycle.js";
import { Scope } from "./port.js";
import { isOverride } from "./provider.js";
import { createScope, type ClosableFinalisers, type TeardownReporter } from "./scope.js";

type AnyModule = {
  readonly imports: readonly AnyModule[];
  readonly provides: readonly AnyProvider[];
};

/** Every provider in the tree, de-duplicated by reference so a diamond yields one entry. */
const flatten = (module: AnyModule): readonly AnyProvider[] => {
  const out = new Set<AnyProvider>();
  const walk = (m: AnyModule): void => {
    for (const imported of m.imports) walk(imported);
    for (const provider of m.provides) out.add(provider);
  };
  walk(module);
  return [...out];
};

/**
 * A wiring bug: a dependency cycle, two providers for one port, a provider for
 * `Scope`, or a dependency nothing provides. Thrown rather than returned, so it
 * lands in unthrown's `Defect` channel — where a wiring bug belongs. Internal:
 * a caller observes it as a `Defect`, never by importing this class.
 */
class WiringDefect extends Error {}

/**
 * Replaces each overridden base provider with its override before any other
 * check runs, so the base is never levelled or constructed. A port the SEED
 * context carries is deliberately not a base: the parent's services are already
 * built.
 */
const resolveOverrides = (providers: readonly AnyProvider[]): readonly AnyProvider[] => {
  const overrides = providers.filter((provider) => isOverride(provider));
  if (overrides.length === 0) return providers;
  const seen = new Set<string>();
  for (const override of overrides) {
    const id = override.port.portId;
    if (seen.has(id)) {
      // Deliberate: same channel as every wiring bug — `run`'s `.map` callback
      // converts the throw to a `Defect`.
      // oxlint-disable-next-line unthrown/no-throw
      throw new WiringDefect(`[di] two overrides registered for port ${JSON.stringify(id)}`);
    }
    seen.add(id);
    if (!providers.some((base) => !isOverride(base) && base.port.portId === id)) {
      // oxlint-disable-next-line unthrown/no-throw -- same rationale as above
      throw new WiringDefect(
        `[di] override for port ${JSON.stringify(id)} with nothing to override — the tree no longer provides it`,
      );
    }
  }
  // Substituted IN PLACE, so declaration order — which the plan relies on for
  // deterministic error selection and `onStart` ordering — is untouched. Only
  // the FIRST base for an id is substituted, so overriding cannot hide a
  // duplicate-provider bug.
  const overrideOf = new Map(overrides.map((override) => [override.port.portId, override]));
  const substituted = new Set<string>();
  return providers.flatMap((provider) => {
    if (isOverride(provider)) return [];
    const override = overrideOf.get(provider.port.portId);
    if (override === undefined || substituted.has(provider.port.portId)) return [provider];
    substituted.add(provider.port.portId);
    return [override];
  });
};

/**
 * Groups providers into levels that may construct concurrently. Runs before any
 * factory, so a cycle or a duplicate is reported with no side effects
 * performed, and preserves declaration order within a level.
 */
const plan = (
  providers: readonly AnyProvider[],
  seedKeys: ReadonlySet<string>,
): readonly (readonly AnyProvider[])[] => {
  providers = resolveOverrides(providers);
  const byPort = new Map<string, AnyProvider>();
  for (const provider of providers) {
    const id = provider.port.portId;
    if (id === Scope.portId) {
      // oxlint-disable-next-line unthrown/no-throw -- see the duplicate-provider throw below
      throw new WiringDefect(`[di] Scope cannot be provided; open one with Module.scoped instead`);
    }
    const existing = byPort.get(id);
    if (existing !== undefined && existing !== provider) {
      // Deliberate: a wiring bug, not a modeled failure. Thrown so `run`'s
      // `.map` callback converts it to a `Defect`.
      // oxlint-disable-next-line unthrown/no-throw
      throw new WiringDefect(`[di] two providers registered for port ${JSON.stringify(id)}`);
    }
    byPort.set(id, provider);
  }

  // Its own pass after the loop, not inside it: a dependency may legitimately be
  // registered by a provider declared later in the array. `isSatisfied` below
  // stays permissive because a port the seed supplies genuinely has no provider
  // here — permissiveness is right for SCHEDULING, and wrong as a substitute
  // for checking, which is the split this pass introduces.
  for (const provider of providers) {
    for (const dep of provider.deps) {
      if (byPort.has(dep.portId) || seedKeys.has(dep.portId)) continue;
      // oxlint-disable-next-line unthrown/no-throw -- same channel as above
      throw new WiringDefect(
        `[di] no provider for port ${JSON.stringify(dep.portId)}, required by ${JSON.stringify(provider.port.portId)}`,
      );
    }
  }

  const levels: AnyProvider[][] = [];
  const placed = new Set<AnyProvider>();
  let remaining = providers;

  // A port nothing provides at all is treated as externally satisfied: an unmet
  // requirement is `Module`'s `Needs` channel's problem, and `Module.forkScope`
  // legitimately depends on ports the built parent context carries.
  const isSatisfied = (portId: string): boolean => {
    const provider = byPort.get(portId);
    return provider === undefined || placed.has(provider);
  };

  while (remaining.length > 0) {
    const ready = remaining.filter((p) => p.deps.every((d) => isSatisfied(d.portId)));
    if (ready.length === 0) {
      const stuck = remaining.map((p) => p.port.portId).join(", ");
      // oxlint-disable-next-line unthrown/no-throw -- same channel as above
      throw new WiringDefect(`[di] dependency cycle among ports: ${stuck}`);
    }
    levels.push(ready);
    for (const p of ready) placed.add(p);
    remaining = remaining.filter((p) => !placed.has(p));
  }
  return levels;
};

/** `run`'s running fold: the `Context` so far, plus every `onStart`-bearing pair. */
type BuildAcc = {
  readonly ctx: Context<never>;
  readonly started: readonly (readonly [AnyProvider, unknown])[];
};

/**
 * Sorts, checks and constructs a module tree. `plan` runs inside a `.map`
 * callback so a `WiringDefect` it throws becomes a `Defect`; nothing before that
 * map runs a factory.
 *
 * `onStart` hooks fire only after the whole fold has finished — one more
 * `.flatMap` appended after it — so the graph is fully built by the time any of
 * them runs.
 */
// The error is genuinely unknown at this boundary: whichever provider fails
// first, or a `WiringDefect`, which lands in the `Defect` channel instead.
export const run = (
  module: AnyModule,
  scope: ClosableFinalisers,
  seed: Context<never> = Context.empty(),
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
): AsyncResult<Context<never>, unknown> =>
  Ok()
    .toAsync()
    .map(() => plan(flatten(module), unsafeKeys(seed)))
    .flatMap((levels) =>
      levels
        // Same rationale as `run`'s own return type just above.
        // oxlint-disable-next-line unthrown/no-ambiguous-error-type
        .reduce<AsyncResult<BuildAcc, unknown>>(
          (acc, level) =>
            acc.flatMap(({ ctx, started }) =>
              constructLevel(level, ctx, scope).map((result) => ({
                ctx: unsafeAddAll(ctx, result.built),
                started: [...started, ...result.started],
              })),
            ),
          Ok({ ctx: seed, started: [] }).toAsync(),
        )
        .flatMap(({ ctx, started }) => runStartHooks(started).map(() => ctx)),
    );

export type ScopedOptions = {
  readonly onTeardownError?: TeardownReporter;
};

/**
 * Runs a module, hands the resulting `Context` to `use`, and closes the scope on
 * every path — construction failure, `use` failure, `use` success — before this
 * function's own `AsyncResult` settles.
 *
 * Built around `await` rather than `tap`/`tapFailure`: `tap`'s callback must be
 * synchronous, so `void scope.close()` inside one is fire-and-forget and lets
 * the result resolve before the last finaliser has run.
 */
export const runScoped = <A, E2>(
  module: AnyModule,
  use: (ctx: Context<never>) => AsyncResult<A, E2>,
  options: ScopedOptions = {},
  seed: Context<never> = Context.empty(),
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- same rationale as `run`'s return type above
): AsyncResult<A, unknown> => {
  const scope = createScope(options.onTeardownError);
  const settle = async () => {
    // oxlint-disable-next-line unicorn/no-array-callback-reference -- `use` is this function's own parameter, not an array method's element callback
    const result = await run(module, scope, seed).flatMap(use);
    // Never conditioned on `result`: teardown happens whether construction
    // failed, `use` failed or `use` succeeded, and never changes what this
    // function returns.
    await scope.close();
    return result;
  };
  // Flattening the lifted `Result` one level is `Result` composition, not the
  // array anti-pattern the rule is built for — there is no array here.
  // oxlint-disable-next-line unicorn/prefer-array-flat
  return fromSafePromise(settle()).flatMap((result) => result);
};
