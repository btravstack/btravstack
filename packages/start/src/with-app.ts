import type { AnyPort, Module, Scope } from "@btravstack/di";

import { start, type RunningApp, type StartOptions } from "./start.js";

/**
 * Start an application, hand it to `use`, and stop it again — whatever `use`
 * does.
 *
 * `signals` and `probes` are always forced off, whatever the caller passes: a
 * harness drives transitions directly, process-wide signal handlers would fight
 * across a test file, and a probe port would collide between tests. A test that
 * needs the real probe server starts the application directly instead.
 *
 * @example
 * ```ts
 * const report = await withApp(AppModule, { runtime }, async (app) => {
 *   app.requestDrain();
 *   return await app.exited;
 * });
 * ```
 *
 * @remarks
 * `use` and `withApp` both speak a bare `Promise`, not an `AsyncResult` — the
 * one harness-shaped exception to this package's rule. `use` is the test body:
 * a thrown assertion failure inside it must reach the test runner, and an
 * `AsyncResult` never rejects, so converting either side would turn a failing
 * `expect` into a `Defect` a caller can forget to unwrap — a green test that
 * asserted nothing. `A` is the test author's own type and carries no error
 * channel, so the wrapper would add no information either.
 *
 * A **`Defect`** on `exited` is therefore rethrown, so that a shutdown that
 * blew up fails the test even when `use` never looked at `exited`. A modeled
 * `Err` is not: a startup failure is an outcome a test may legitimately be
 * asserting. A test that wants to assert the defect itself calls `start`
 * directly, the same escape hatch a test needing the real probe server uses.
 */
export const withApp = async <X, E, Needs extends AnyPort, A, Info = never>(
  module: Module<X, E, Scope>,
  options: StartOptions<Needs, Info>,
  use: (app: RunningApp<E, Info>) => Promise<A>,
  // The same phantom gate `start` carries, for the same reason: it makes the
  // runtime's declared needs a compile-time check at *this* call site.
  ...gate: [InstanceType<Needs>] extends [X]
    ? []
    : [error: "UNSATISFIED RUNTIME NEEDS", missing: Exclude<InstanceType<Needs>, X>]
): Promise<A> => {
  void gate;

  // The gate above proves the needs at the call site, but that proof is not
  // visible inside a body where `X` and `Needs` are still unresolved type
  // parameters — the same reason `start` asserts its own runtime context. So
  // the forwarding call goes through a signature with the phantom tuple
  // already discharged.
  const boot = start as (
    module: Module<X, E, Scope>,
    options: StartOptions<Needs, Info>,
  ) => RunningApp<E, Info>;

  const app = boot(module, { ...options, signals: false, probes: false });

  // `use`'s own failure is held rather than propagated straight away: the
  // application must still be stopped, and its failure must not mask this one.
  let thrownByUse: { readonly cause: unknown } | undefined;
  let used!: A;
  try {
    used = await use(app);
  } catch (cause) {
    thrownByUse = { cause };
  }

  // Both are no-ops if `use` already drove the application to exit, and both
  // are needed if it did not — including when `use` threw.
  app.stop();
  const exit = await app.exited;

  if (thrownByUse !== undefined) {
    // oxlint-disable-next-line unthrown/no-throw -- rethrowing `use`'s own failure unchanged: a failed `expect` must reach the test runner as the throw it was, and it outranks anything the shutdown says
    throw thrownByUse.cause;
  }

  // The `Result` this harness awaits is examined, not discarded: `exited`'s
  // `never` empties the *error* channel only, and a `use` that never read
  // `exited` would otherwise let a shutdown defect pass as a green test.
  if (exit.isDefect()) {
    // oxlint-disable-next-line unthrown/no-throw -- a defect is an unmodeled kernel failure and this is a test harness: the only way it reaches the test runner is as a throw
    throw exit.cause;
  }

  return used;
};
