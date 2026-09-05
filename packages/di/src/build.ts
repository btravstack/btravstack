import { OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

import { Context, unsafeAdd, unsafeAddAll, unsafeKeys } from "./context.js";
import { constructLevel, runStartHooks, type AnyProvider } from "./lifecycle.js";
import { Scope, type AnyPort, type ServiceOf } from "./port.js";
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
 *
 * A set port (`port.many === true`) is exempt from the duplicate check —
 * several providers targeting it is `Provider.member`'s whole point. That
 * exemption is why `placed` is keyed by provider identity and readiness
 * compares counts: keyed by bare `portId`, the FIRST member landing would drop
 * its not-yet-placed siblings out of `remaining` and mark the set port ready,
 * silently losing whatever was still pending in a later level.
 */
const plan = (
  providers: readonly AnyProvider[],
  seedKeys: ReadonlySet<string>,
): readonly (readonly AnyProvider[])[] => {
  providers = resolveOverrides(providers);
  const byPort = new Map<string, AnyProvider>();
  const totalByPort = new Map<string, number>();
  const manyByPort = new Map<string, boolean>();
  for (const provider of providers) {
    const id = provider.port.portId;
    // A provider for `Scope` is a wiring bug, not merely an unmet-dependency
    // gap (see `Scope`'s own doc comment in `port.ts` for why this is a
    // runtime `portId` check, not a type-level guard). `Scope` is never a set
    // port, so this runs — unaffected — before the many-port exemption below.
    if (id === Scope.portId) {
      // oxlint-disable-next-line unthrown/no-throw -- see the duplicate-provider throw below
      throw new WiringDefect(`[di] Scope cannot be provided; open one with Module.scoped instead`);
    }
    const isMany = provider.port.many === true;
    const seenMany = manyByPort.get(id);
    if (seenMany !== undefined && seenMany !== isMany) {
      // Same class of wiring bug as the duplicate-provider throw below, and
      // thrown for the same reason: a portId declared as an ordinary port by
      // one provider and a set port by another is a declaration bug, not
      // something `unsafeAddAll` (`context.ts`) should have to cope with —
      // left unchecked, whichever provider lands second silently `continue`s
      // past (if it is the set-port one) or overwrites (if it is the
      // ordinary one) `byPort`'s entry, and the failure that eventually
      // surfaces is `unsafeAddAll` spreading a non-array single service, a
      // `TypeError` defect whose message says nothing about the real cause.
      // oxlint-disable-next-line unthrown/no-throw
      throw new WiringDefect(
        `[di] port ${JSON.stringify(id)} is registered as both a set port and an ordinary port`,
      );
    }
    manyByPort.set(id, isMany);
    totalByPort.set(id, (totalByPort.get(id) ?? 0) + 1);
    // Members accumulate; several providers for one set port are not a
    // collision. Keyed on `many === true` — the static field `Port.many`
    // attaches — so an ordinary port is never accidentally exempted.
    if (isMany) {
      byPort.set(id, provider);
      continue;
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
  const placedCountByPort = new Map<string, number>();
  let remaining = providers;

  // A dependency is satisfied once every provider registered for its port has
  // been placed — one for an ordinary port, every member for a set port. A port
  // nothing provides at all is externally satisfied: an unmet requirement is
  // `Module`'s `Needs` channel's problem, and `Module.forkScope` legitimately
  // depends on ports the built parent context carries.
  const isSatisfied = (portId: string): boolean =>
    !byPort.has(portId) || placedCountByPort.get(portId) === totalByPort.get(portId);

  while (remaining.length > 0) {
    const ready = remaining.filter((p) => p.deps.every((d) => isSatisfied(d.portId)));
    if (ready.length === 0) {
      const stuck = remaining.map((p) => p.port.portId).join(", ");
      // oxlint-disable-next-line unthrown/no-throw -- same channel as above
      throw new WiringDefect(`[di] dependency cycle among ports: ${stuck}`);
    }
    levels.push(ready);
    for (const p of ready) {
      placed.add(p);
      const id = p.port.portId;
      placedCountByPort.set(id, (placedCountByPort.get(id) ?? 0) + 1);
    }
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
  OkAsync()
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
          OkAsync({ ctx: seed, started: [] }),
        )
        .flatMap(({ ctx, started }) => runStartHooks(started).map(() => ctx)),
    );

export type SeedEntry<P extends AnyPort> = readonly [port: P, value: ServiceOf<InstanceType<P>>];

export type ScopedOptions = {
  readonly onTeardownError?: TeardownReporter;
  /**
   * Values supplied to the scope from OUTSIDE its module tree, keyed by port.
   * The planner treats a seeded port as provided, exactly as it treats the
   * parent's services — a seed is more keys on the same context.
   */
  readonly seed?: readonly SeedEntry<AnyPort>[];
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
  const seeded = (options.seed ?? []).reduce<Context<never>>(
    (ctx, [port, value]) => unsafeAdd(ctx, port, value) as Context<never>,
    seed,
  );
  const settle = async () => {
    // oxlint-disable-next-line unicorn/no-array-callback-reference -- `use` is this function's own parameter, not an array method's element callback
    const result = await run(module, scope, seeded).flatMap(use);
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
