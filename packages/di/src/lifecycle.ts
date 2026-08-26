import { OkAsync, allAsync, fromSafePromise, type AsyncResult } from "unthrown";

import type { Context } from "./context.js";
import type { AnyPort } from "./port.js";
import type { ClosableFinalisers } from "./scope.js";

/**
 * The build pipeline's own view of a provider. `module.ts`'s `AnyProvider`
 * erases `construct`, `release` and the hooks so the module algebra never has to
 * reason about how a port is built; this file and `build.ts` are the code that
 * does need them.
 */
export type AnyProvider = {
  readonly port: AnyPort;
  readonly deps: readonly AnyPort[];
  // The package's own construction boundary — same rationale as `provider.ts`'s
  // identical field, which this type mirrors.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
  readonly construct: (services: readonly unknown[]) => AsyncResult<unknown, unknown>;
  readonly release: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStart: ((service: unknown) => void | Promise<void>) | undefined;
  readonly onStop: ((service: unknown) => void | Promise<void>) | undefined;
};

/**
 * Reads a service an earlier level placed into `ctx`. Not `Context`'s public
 * `get`, whose `S extends R` bound is uncallable against a structural `AnyPort`.
 */
const unsafeGet = (ctx: Context<never>, port: AnyPort): unknown =>
  (ctx as unknown as { readonly get: (p: AnyPort) => unknown }).get(port);

/**
 * One level's outcome. `started` is read off the settled values POSITIONALLY,
 * never pushed as each promise settles: same-level providers construct
 * concurrently, so a push would land in arrival order rather than declaration
 * order.
 */
export type ConstructedLevel = {
  readonly built: readonly (readonly [AnyPort, unknown])[];
  readonly started: readonly (readonly [AnyProvider, unknown])[];
};

/**
 * Constructs one level. Every provider's `construct` is called in the same
 * synchronous pass, before any is awaited, so they genuinely run concurrently;
 * `allAsync` then folds positionally and keeps the first `Err` in declaration
 * order rather than the first to settle.
 *
 * That tiebreak holds within a channel, not across them: a later provider that
 * throws outranks an earlier one that returned `Err`, since a wiring bug should
 * not be reported as another provider's branchable error. Deterministic either
 * way — the outcome depends only on declaration order and on which channel each
 * provider failed on.
 */
export const constructLevel = (
  level: readonly AnyProvider[],
  ctx: Context<never>,
  scope: ClosableFinalisers,
  // Whichever level provider's `construct` fails first — see the field comment
  // on `AnyProvider.construct`.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type
): AsyncResult<ConstructedLevel, unknown> => {
  const settling = level.map((provider) => {
    const services = provider.deps.map((dep) => unsafeGet(ctx, dep));
    // Registered the moment THIS provider succeeds, not after the level: a
    // sibling may still fail, and the unwind needs every acquired resource on
    // the scope by then. `onStop` is registered in the same `tap` so the two
    // land adjacently and unwind together in one LIFO pass.
    return provider.construct(services).tap((service) => {
      if (provider.release !== undefined) {
        scope.onStop(provider.port.portId, () => provider.release!(service));
      }
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
 * Fires every collected `onStart` once the whole graph has constructed — never
 * per level, never inline with `construct` — sequentially, in declaration order.
 *
 * Threaded through `flatMap` rather than `Promise.all`: a throwing hook must
 * stop the rest and surface as a `Defect`. `fromSafePromise` takes a THUNK, not
 * an already-invoked call, so a synchronous throw is caught too.
 *
 * Asymmetric with teardown, deliberately: a failing `onStart` skips every hook
 * after it, while `scope.close()` still runs every registered `onStop`. A
 * resource a provider actually acquired must always be released.
 */
export const runStartHooks = (
  entries: readonly (readonly [AnyProvider, unknown])[],
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- same rationale as `AnyProvider.construct`
): AsyncResult<void, unknown> =>
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- same rationale as the return type above
  entries.reduce<AsyncResult<void, unknown>>(
    (acc, [provider, service]) =>
      acc.flatMap(() => fromSafePromise(() => Promise.resolve(provider.onStart!(service)))),
    OkAsync(),
  );
