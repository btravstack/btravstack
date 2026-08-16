import type { Env } from "@btravstack/config";
import {
  start,
  type RunningApp,
  type RuntimeInfoOf,
  type StartGate,
  type StartOptions,
} from "@btravstack/core";
import type { Module, Scope } from "@btravstack/di";

/**
 * `start`, as a test hands it out: the same signature and the same phantom
 * gate, minus `signals` (always off) — every application it starts is stopped
 * when the test ends.
 */
export type Boot = <X, E, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, Scope | Env>,
  options?: Omit<StartOptions<UnitX, UnitNeeds>, "signals">,
  ...gate: StartGate<X, UnitNeeds>
) => RunningApp<E, RuntimeInfoOf<X>>;

/** What every `boot` in the fixture starts with; a call's own options win. */
export type BootDefaults = Omit<StartOptions, "signals" | "unit">;

/**
 * A `test.extend` fixture that hands the test a {@link Boot} and stops every
 * application it started once the test is over — on every exit path, a failing
 * assertion included, which is what `test.extend`'s teardown is for.
 *
 * ```ts
 * export const it = test.extend<{ boot: Boot }>({
 *   boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
 * });
 *
 * it("answers", async ({ boot }) => {
 *   const app = boot(OrderApi, { unit: RequestModule });
 *   …
 * });
 * ```
 *
 * The defaults are a test's: `signals: false` always (process-wide signal
 * handlers would fight across a file), `probes: false` unless a call asks
 * for a port (`{ port: 0 }` — an ephemeral one cannot collide),
 * `preDrainDelayMs: 0` (a test has no Kubernetes endpoint to wait for) and a
 * silent `onEvent` — each overridable by `defaults` and again per call.
 *
 * Teardown is `stop()`, then `exited` is examined — a
 * **`Defect`** fails the test even when the test never looked at `exited`
 * (a shutdown that blew up must not pass green), while a modeled `Err` passes
 * through, since a startup failure is an outcome a test may be asserting.
 */
export const bootFixture =
  (defaults: BootDefaults = {}) =>
  // oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require a destructuring pattern; this one depends on no other fixture
  async ({}: object, use: (boot: Boot) => Promise<void>): Promise<void> => {
    const started: RunningApp<unknown, unknown>[] = [];

    // The gate is proven at each `boot` call site and invisible in this body,
    // where `X` and `UnitNeeds` are unresolved — the same discharged-signature
    // cast the kernel's own forwarding makes.
    const boot = ((module: Module<never, unknown, Scope | Env>, options = {}) => {
      const app = (
        start as unknown as (
          module: Module<never, unknown, Scope | Env>,
          options: StartOptions<unknown, unknown>,
        ) => RunningApp<unknown, unknown>
      )(module, {
        preDrainDelayMs: 0,
        onEvent: () => {},
        probes: false,
        ...defaults,
        ...options,
        signals: false,
      });
      started.push(app);
      return app;
    }) as unknown as Boot;

    await use(boot);

    for (const app of started) {
      app.stop();
      const exit = await app.exited;
      if (exit.isDefect()) {
        // oxlint-disable-next-line unthrown/no-throw -- a defect is an unmodeled kernel failure and this is a test harness: the only way it reaches the test runner is as a throw
        throw exit.cause;
      }
    }
  };
