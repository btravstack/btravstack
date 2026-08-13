import { Ok, allAsync, fromSafePromise, type AsyncResult } from "unthrown";

import type { Context } from "./context.js";
import type { AnyPort } from "./port.js";
import type { ClosableFinalisers } from "./scope.js";

/**
 * `Module.provides`'s own public type (`module.ts`'s `AnyProvider`) is
 * deliberately structural down to `port`/`deps` only — it erases
 * `construct`, `release`, `onStart` and `onStop` so the module algebra never
 * has to reason about how a port gets built or torn down. The build
 * pipeline (this file plus `build.ts`) is exactly the code that *does* need
 * those fields, so it gets its own, richer view of the same runtime objects
 * rather than reusing `module.ts`'s.
 */
export type AnyProvider = {
  readonly port: AnyPort;
  readonly deps: readonly AnyPort[];
  // This is the package's own construction boundary, not application code —
  // same rationale as `provider.ts`'s identical field, which this type mirrors.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
  readonly construct: (services: readonly unknown[]) => AsyncResult<unknown, unknown>;
  readonly release: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStart: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStop: ((service: unknown) => void | Promise<void>) | undefined;
};

/**
 * Reads a service that some earlier level has already placed into `ctx`. Not
 * `Context`'s public `get` — that method's `S extends R` bound makes it
 * uncallable against a port typed only as the structural `AnyPort` this
 * module works with (nothing but `never` extends the `Context<never>` this
 * pipeline threads through `build.ts`'s `run`). This mirrors `context.ts`'s
 * own internal `PortLike` escape hatch for the same reason.
 */
const unsafeGet = (ctx: Context<never>, port: AnyPort): unknown =>
  (ctx as unknown as { readonly get: (p: AnyPort) => unknown }).get(port);

/**
 * One level's outcome: the `[port, service]` entries to fold into the
 * running `Context`, plus the `[provider, service]` pairs whose `onStart` is
 * defined. `started` is read off `values` *positionally* (by index into
 * `level`), not pushed inside `constructLevel`'s `tap` as each provider's
 * promise happens to settle — same-level providers construct concurrently
 * (see the doc comment below), so a `tap`-based push would land in
 * whichever order they resolved in, not declaration order. Reading it off
 * the already-settled, positionally-ordered `values` keeps `started` in
 * declaration order regardless of which one finished first.
 */
export type ConstructedLevel = {
  readonly built: readonly (readonly [AnyPort, unknown])[];
  readonly started: readonly (readonly [AnyProvider, unknown])[];
};

/**
 * Constructs one level. Every provider in the level is started — its
 * `construct` called — in the same synchronous pass, *before* any of them is
 * awaited, so they genuinely run concurrently rather than one-after-another.
 * `allAsync` (unthrown's `Promise.all`-backed aggregate) then awaits every one
 * of them to settle before folding: its fold walks the resolved array in
 * *positional* order and keeps the first `Err` it meets, so a provider
 * declared earlier wins even if a later one's promise happens to land first —
 * exactly the "declaration order, not arrival order" contract this pipeline
 * needs. See `build.spec.ts`'s "the error from a parallel level is the first
 * in declaration order" for the behavioural proof.
 *
 * That contract holds *within* a channel, not across them. `allAsync`'s fold
 * records the first `Err` but does not stop at it; it stops at the first
 * `Defect`, and returns the defect in preference to any `Err` it had already
 * recorded. So a *later* provider that throws outranks an *earlier* provider
 * that returned `Err` — "first in declaration order" is the tiebreak among
 * equals, and a defect is not one. Still fully deterministic: the outcome
 * depends only on declaration order and on which channel each provider failed
 * on, never on which promise settled first. It is also the right precedence,
 * since a wiring bug in one provider should not be reported to the caller as
 * another provider's modeled, branchable error.
 */
export const constructLevel = (
  level: readonly AnyProvider[],
  ctx: Context<never>,
  scope: ClosableFinalisers,
  // The error is genuinely unknown here: it is whichever level provider's
  // `construct` fails first, and `construct` itself is typed this way for the
  // same reason (see the field comment on `AnyProvider.construct`).
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
): AsyncResult<ConstructedLevel, unknown> => {
  const settling = level.map((provider) => {
    const services = provider.deps.map((dep) => unsafeGet(ctx, dep));
    // Registered the moment *this provider's* construction succeeds, not
    // after the whole level (or the whole graph) settles — a sibling in the
    // same level, or a later level, may still fail, and the partial-failure
    // unwind (see `build.ts`'s `runScoped`) needs every already-acquired
    // resource on the scope by the time that happens, not just the ones
    // that happened to be declared first. A provider with no `release`
    // (every arm but `acquire`) never registers anything, so it never gets
    // torn down.
    return provider.construct(services).tap((service) => {
      if (provider.release !== undefined) {
        scope.onStop(provider.port.portId, () => provider.release!(service));
      }
      // Registered right beside `release`, in the same `tap` call, so the
      // two land adjacently in the scope's finaliser list — unwound
      // together in one LIFO pass on close, not as two separate passes over
      // the providers.
      if (provider.onStop !== undefined) {
        scope.onStop(provider.port.portId, () => provider.onStop!(service));
      }
    });
  });
  return allAsync(settling).map((values) => ({
    built: values.map((value, i) => [level[i]!.port, value] as const),
    started: values
      .map((value, i) => [level[i]!, value] as const)
      .filter(([provider]) => provider.onStart !== undefined),
  }));
};

/**
 * Fires every collected `onStart` hook once the whole graph has finished
 * constructing — never per level, never inline with `construct` — one after
 * another in the order `entries` lists them. `build.ts`'s `run` is what
 * guarantees that order is declaration order: each level's hooks are
 * collected *after* `allAsync` resolves, positionally (see `constructLevel`
 * above), so same-level concurrent construction cannot reorder them, and
 * levels themselves are appended level-by-level in the sequence `plan`
 * produced.
 *
 * Threaded through `AsyncResult.flatMap` rather than `Promise.all`-ed: hooks
 * run sequentially, and a throwing or rejecting hook must stop the rest and
 * surface as a `Defect` (the same channel a failed `construct` uses), not be
 * silently raced against its siblings. `fromSafePromise` is what gives a
 * thrown or rejected hook that `Defect` outcome — passed a thunk, not an
 * already-invoked call, so a *synchronous* throw is caught too, not just a
 * rejected promise (its `Promise.resolve().then(promise)` internals invoke
 * the thunk inside the `.then`, where a throw becomes a rejection like any
 * other).
 *
 * Asymmetric with teardown, deliberately: a throwing/rejecting `onStart`
 * short-circuits this `reduce` (`acc.flatMap` never calls the next hook once
 * `acc` is an `Err`/`Defect`), so every `onStart` declared after the failing
 * one is skipped — but `scope.close()` (`scope.ts`) still runs *every*
 * registered `onStop`, including for providers whose own `onStart` never got
 * to run. The two channels aren't symmetric: `onStart` is forward
 * initialization work with no obligation to run at all if a peer's already
 * failed, while `onStop`/`release` are undoing work that already happened —
 * a resource a provider actually acquired must always be released, whether
 * or not that provider (or a later one) ever reached its `onStart`.
 */
export const runStartHooks = (
  entries: readonly (readonly [AnyProvider, unknown])[],
  // The failing hook's cause is genuinely unknown here — same rationale as
  // `AnyProvider.construct` above.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
): AsyncResult<void, unknown> =>
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- same rationale as the return type above
  entries.reduce<AsyncResult<void, unknown>>(
    (acc, [provider, service]) =>
      acc.flatMap(() => fromSafePromise(() => Promise.resolve(provider.onStart!(service)))),
    Ok().toAsync(),
  );
