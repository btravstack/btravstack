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
 */
export const withApp = async <X, E, Needs extends AnyPort, A>(
  module: Module<X, E, Scope>,
  options: StartOptions<Needs>,
  use: (app: RunningApp<E>) => Promise<A>,
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
    options: StartOptions<Needs>,
  ) => RunningApp<E>;

  const app = boot(module, { ...options, signals: false, probes: false });

  try {
    return await use(app);
  } finally {
    // Both are no-ops if `use` already drove the application to exit, and both
    // are needed if it did not — including when `use` threw.
    app.stop();
    await app.exited;
  }
};
