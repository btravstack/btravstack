import { Ok, fromSafePromise, type AsyncResult } from "unthrown";

import { Context, unsafeAddAll, unsafeKeys } from "./context.js";
import { constructLevel, runStartHooks, type AnyProvider } from "./lifecycle.js";
import { Scope } from "./port.js";
import { createScope, type ClosableFinalisers, type TeardownReporter } from "./scope.js";

type AnyModule = {
  readonly imports: readonly AnyModule[];
  readonly provides: readonly AnyProvider[];
};

/**
 * Every provider in the tree, de-duplicated by reference so a diamond yields one entry.
 * Not part of the public surface — `run` (this file) is the only caller; `index.ts`
 * deliberately does not re-export it (see `unsafeAdd`'s own note in `context.ts` for
 * the same "internal, package-private" rationale).
 */
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
 * A wiring bug: a dependency cycle, two distinct providers registered for the
 * same port, a port registered as both a set port and an ordinary one, a
 * provider for `Scope`, or a dependency nothing provides. `plan` throws this
 * rather than returning it, on purpose —
 * see the note on `run` below for why that is the correct channel for it.
 * Internal only: a caller observes a `WiringDefect` through unthrown's
 * `Defect` channel (`toBeDefect()` in the test suite), never by importing
 * this class, so it is not part of `index.ts`'s public surface.
 */
class WiringDefect extends Error {}

/**
 * Groups providers into levels that may construct concurrently. Runs before any
 * factory, so a cycle or a duplicate is reported with no side effects performed.
 * Declaration order is preserved within a level, which is what makes the error
 * chosen on failure deterministic (see `run`).
 *
 * A set port (`port.many === true`) is exempt from the duplicate check —
 * several providers targeting it is `Provider.member`'s whole point, not a
 * collision. That exemption ripples into leveling below: the brief's sketch
 * kept `placed`/`remaining` keyed by bare `portId`, assuming one provider per
 * port, which under several members sharing one portId would both drop
 * not-yet-placed siblings out of `remaining` the moment the *first* member
 * landed, and make a consumer of the set port "ready" after that first member
 * too — silently losing whatever was still pending in a later level. `placed`
 * is therefore a `Set<AnyProvider>` (provider identity, not portId), and
 * readiness for a many-port dependency compares its placed count against its
 * total member count, not mere presence.
 * Internal only, same as `flatten` above — `run` is the only caller.
 */
const plan = (
  providers: readonly AnyProvider[],
  seedKeys: ReadonlySet<string>,
): readonly (readonly AnyProvider[])[] => {
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
      // oxlint-disable-next-line unthrown/no-throw -- see the rationale on the duplicate-provider throw just below
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
      // Deliberate: a duplicate-provider registration is a wiring bug, not a
      // modeled failure the caller branches on. Thrown here, on purpose, so
      // the `.map` callback in `run` that calls `plan` converts it to a
      // `Defect` via unthrown's throw-to-defect net.
      // oxlint-disable-next-line unthrown/no-throw
      throw new WiringDefect(`[di] two providers registered for port ${JSON.stringify(id)}`);
    }
    byPort.set(id, provider);
  }

  // A dependency that no provider in the tree supplies, and that the seed
  // context does not already carry, is a wiring bug — and belongs in the same
  // pre-construction channel as a cycle or a duplicate, which is where every
  // other wiring bug already lands. Run as its own pass after the loop above,
  // not inside it, because a dependency may legitimately be registered by a
  // provider declared later in the array.
  //
  // The seed is what makes this safe to raise at all: `isSatisfied` below
  // stays deliberately permissive, because a port the seed supplies genuinely
  // has no provider here — that is exactly the shape `Module.forkScope`
  // (`module.ts`) builds, where a request module's providers depend on ports
  // the already-built parent context carries. Permissiveness is right for
  // *scheduling*; it is only wrong as a substitute for *checking*, which is
  // the split this pass introduces.
  //
  // Left unchecked, such a dependency was silently treated as ready, survived
  // levelling, and surfaced only when `constructLevel` looked it up — as
  // `context.ts`'s `[di] no service registered for port …`, a message whose
  // own comment calls it unreachable and a bug in this package. It is neither:
  // it is the caller's graph missing a provider, and it now says so, before
  // any factory has run.
  for (const provider of providers) {
    for (const dep of provider.deps) {
      if (byPort.has(dep.portId) || seedKeys.has(dep.portId)) continue;
      // Deliberate: same rationale and same channel as the duplicate-provider
      // and cycle throws above — `run`'s `.map` callback converts it to a
      // `Defect`.
      // oxlint-disable-next-line unthrown/no-throw
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
  // been placed — one, for an ordinary port; every member, for a set port. A
  // port nothing provides at all is treated as externally satisfied, same as
  // before: an unmet requirement is `Module`'s `Needs` channel's problem.
  const isSatisfied = (portId: string): boolean =>
    !byPort.has(portId) || placedCountByPort.get(portId) === totalByPort.get(portId);

  while (remaining.length > 0) {
    const ready = remaining.filter((p) => p.deps.every((d) => isSatisfied(d.portId)));
    if (ready.length === 0) {
      const stuck = remaining.map((p) => p.port.portId).join(", ");
      // Deliberate: same rationale as the duplicate-provider throw above — a
      // cycle is a wiring bug, meant to surface as a `Defect` via `run`'s
      // `.map` callback, not as a modeled `Err`.
      // oxlint-disable-next-line unthrown/no-throw
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

/**
 * `run`'s running fold: the `Context` built so far, plus every
 * `onStart`-bearing pair collected across levels, in level order (each
 * level's own entries already positional — see `lifecycle.ts`'s
 * `ConstructedLevel`, which `constructLevel` returns).
 */
type BuildAcc = {
  readonly ctx: Context<never>;
  readonly started: readonly (readonly [AnyProvider, unknown])[];
};

/**
 * Sorts, checks and constructs a module tree. `plan` runs inside a `.map`
 * callback rather than being called directly: a `WiringDefect` it throws is a
 * wiring bug, not a modeled failure the caller is expected to branch on, and
 * unthrown's combinators catch a thrown callback and turn it into a `Defect`
 * (verified in `build.spec.ts` via `toBeDefect()`, not merely assumed) —
 * exactly the channel a wiring bug belongs on. Nothing before this map runs
 * a factory, so a cycle or a duplicate is reported with zero side effects.
 *
 * `onStart` hooks fire only after the whole `levels.reduce` has finished —
 * not folded into `constructLevel`, not run per level — via one more
 * `.flatMap` appended after the fold, so the graph is fully built by the
 * time any of them runs.
 */
// The error is genuinely unknown at this boundary: it is whichever provider
// in the tree fails first (see the field comment on `AnyProvider.construct`),
// or a `WiringDefect` — which never reaches `E` at all, since it is thrown
// and so lands in the `Defect` channel instead.
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
 * Runs a module, hands the resulting `Context` to `use`, and closes the scope
 * on every path — construction failure, `use` failure, `use` success — before
 * this function's own `AsyncResult` ever settles.
 *
 * The brief's sketch chains this with `.tap`/`.tapFailure` on `run(...).flatMap(use)`,
 * firing `scope.close()` as a side effect. That does not hold up: `tap`'s callback
 * must be synchronous (see `NotThenable` in unthrown's types — it exists precisely
 * to keep async work out of `tap`), so `void scope.close()` inside one is
 * fire-and-forget. `close` awaits each finaliser in turn, so a fire-and-forget call
 * lets this function's result resolve before teardown — in particular before the
 * *last* finaliser has necessarily run — which breaks exactly the ordering the
 * unwind tests assert on (`released` must already hold every entry once
 * `Module.scoped` resolves). Built explicitly around `await` instead: the settling
 * `Promise` is lifted back into an `AsyncResult` with `fromSafePromise` (it cannot
 * reject — `run`/`flatMap`/`scope.close` all resolve to a value, never a rejected
 * promise) and then flattened, since it resolves to a `Result` rather than a bare
 * value.
 */
export const runScoped = <A, E2>(
  module: AnyModule,
  use: (ctx: Context<never>) => AsyncResult<A, E2>,
  options: ScopedOptions = {},
  seed: Context<never> = Context.empty(),
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- same rationale as `run`'s return type above
): AsyncResult<A, unknown> => {
  const scope = createScope(options.onTeardownError);
  // Deliberately a bare `async` function, not further unthrown combinators:
  // it needs to `await` the scope's own close before deciding what settled,
  // which is exactly the ordering `tap`/`tapFailure` cannot express (see the
  // doc comment above). Its inferred return type is a plain
  // `Promise<Result<A, unknown>>` — left inferred, not spelled out, since an
  // explicit `Result`-in-a-`Promise` annotation is the shape
  // `unthrown/prefer-async-result` warns against in general; here it is the
  // unavoidable seam between this function's `await`-based body and
  // `fromSafePromise`, which is what turns it back into a real `AsyncResult`
  // immediately below.
  const settle = async () => {
    // oxlint-disable-next-line unicorn/no-array-callback-reference -- `use` is this function's own parameter, not an array method's element callback
    const result = await run(module, scope, seed).flatMap(use);
    // Never conditioned on `result`: teardown must happen whether construction
    // failed, `use` failed, or `use` succeeded, and it must never change what
    // this function returns (`close` swallows and reports its own failures —
    // see `scope.ts` — so it cannot mask `result` even on a rejecting release).
    await scope.close();
    return result;
  };
  // `fromSafePromise` lifts the settled `Result` into an `AsyncResult<Result<A,
  // unknown>, never>`; flattening it one level is `Result`/`AsyncResult`
  // composition, not the `Array#flatMap(x => x)` anti-pattern
  // `unicorn/prefer-array-flat` is built for — there is no array here.
  // oxlint-disable-next-line unicorn/prefer-array-flat
  return fromSafePromise(settle()).flatMap((result) => result);
};
