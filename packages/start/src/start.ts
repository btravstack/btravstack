import { Module, type AnyPort, type Context, type Scope } from "@btravstack/di";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { systemClock, type Clock } from "./clock.js";
import { createDeferred } from "./deferred.js";
import type { DrainReport } from "./drain-report.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { createPhaseTracker, type Phase, type PhaseTracker } from "./phase.js";
import type { RunUnit, Runtime, RuntimeStartFailed, Serving } from "./runtime.js";
import { createUnitRegistry, type UnitRegistry } from "./units.js";

export type TeardownError = { readonly port: string; readonly cause: unknown };

export type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined;
  readonly teardownErrors: readonly TeardownError[];
  readonly uptimeMs: number;
};

export type StartOptions<Needs extends AnyPort> = {
  readonly runtime: Runtime<Needs>;
  readonly clock?: Clock;
  readonly signals?: boolean;
  readonly probes?: { readonly port: number } | false;
  readonly preDrainDelayMs?: number;
  readonly drainTimeoutMs?: number;
  readonly onEvent?: EventSink;
};

export type RunningApp<E> = {
  readonly exited: AsyncResult<ExitReport, E | RuntimeStartFailed>;
  readonly stop: () => void;
  readonly phase: () => Phase;
};

const finish = (
  serving: Serving,
  reason: ExitReport["reason"],
  tracker: PhaseTracker,
  // Task 8 drains through the registry here; until then it is only carried.
  registry: UnitRegistry,
  clock: Clock,
  startedAt: number,
  teardownErrors: readonly TeardownError[],
): AsyncResult<ExitReport, never> => {
  void registry;
  tracker.advanceTo("stopping");

  return serving.stop().map(() => {
    tracker.advanceTo("exited");
    return {
      reason,
      drain: undefined,
      // The aliasing is LOAD-BEARING: this is the same mutable array
      // `onTeardownError` pushes into, and di closes the scope *after* `use`
      // settles but *before* its own result settles — so every finaliser
      // failure lands in the array after this object is built and before the
      // caller can observe it. A defensive copy here (or anywhere on this
      // path) would silently drop every teardown error.
      teardownErrors,
      uptimeMs: clock.now() - startedAt,
    };
  });
};

// `Module<X, E, Scope>`, not `Module<X, E, never>`: `Needs` sits in covariant
// position on `Module`, so this accepts a module with no needs at all *and* the
// resourceful one whose `acquire`/`release` provider adds `Scope` — the single
// need `Module.scoped` discharges by opening the scope itself. A module with a
// genuine unmet dependency is rejected here, as di's own gate would reject it.
// The `gate` rest parameter is a phantom: it never carries a runtime argument.
// It is what makes the runtime's declared needs a *compile-time* check — a
// runtime needing a port the module does not export makes the tuple non-empty,
// so the call fails to typecheck. A trailing rest tuple rather than a
// conditional type on `module` or `options` is deliberate: a conditional on an
// inference-bearing parameter makes TypeScript defer that parameter's
// inference and can collapse `X` or `E` to `unknown`. Same shape, and the same
// reasoning, as di's own UNSATISFIED DEPENDENCIES gate on `Module.scoped`.
export const start = <X, E, Needs extends AnyPort>(
  module: Module<X, E, Scope>,
  options: StartOptions<Needs>,
  ...gate: [InstanceType<Needs>] extends [X]
    ? []
    : [error: "UNSATISFIED RUNTIME NEEDS", missing: Exclude<InstanceType<Needs>, X>]
): RunningApp<E> => {
  void gate;
  const clock = options.clock ?? systemClock;
  const emit = safeSink(options.onEvent ?? stderrSink);
  const tracker = createPhaseTracker((phase) => {
    if (phase === "serving") emit({ type: "serving", runtime: options.runtime.name });
    if (phase === "stopping") emit({ type: "stopping" });
    if (phase === "exited") emit({ type: "exited" });
  });

  const registry = createUnitRegistry();
  const shutdown = createDeferred<ExitReport["reason"]>();
  const teardownErrors: TeardownError[] = [];
  const startedAt = clock.now();

  emit({ type: "building" });

  const exited = Module.scoped(
    module,
    (ctx: Context<X>): AsyncResult<ExitReport, RuntimeStartFailed> => {
      tracker.advanceTo("starting");

      // `Context<in R>` is contravariant, so an application context whose
      // exports cover the runtime's needs is assignable here. The assertion is
      // needed only because the `gate` rest parameter proves
      // `InstanceType<Needs> extends X` at the *call site*, and that proof is
      // not visible to the checker inside this body, where `X` and `Needs` are
      // still unresolved type parameters.
      const runtimeCtx = ctx as unknown as Context<InstanceType<Needs>>;

      // The registry counts and aborts; it knows nothing about contexts. The
      // kernel is what closes over `runtimeCtx` and hands a runtime the
      // two-argument `RunUnit` its handlers expect. When the `unit` module
      // lands (deferred, see the end of this plan), the `Module.forkScope`
      // call goes exactly here, replacing `runtimeCtx` with the fork's context.
      // An annotation, not an assertion: a future divergence between this
      // adapter and `RunUnit` is reported here rather than absorbed.
      const run: RunUnit<Needs> = (meta, work) =>
        registry.run(meta, (signal) => work(runtimeCtx, signal));

      const host = { ctx: runtimeCtx, run };

      return options.runtime.start(host).flatMap((serving: Serving) => {
        tracker.advanceTo("serving");

        return fromSafePromise(shutdown.promise).flatMap((reason) =>
          finish(serving, reason, tracker, registry, clock, startedAt, teardownErrors),
        );
      });
    },
    {
      onTeardownError: (port, cause) => {
        teardownErrors.push({ port, cause });
        emit({ type: "teardownError", port, cause });
      },
    },
    // Construction failed, or the runtime refused to start: `use` never
    // reached `finish`, so nothing has moved the tracker off a live phase.
    // The plan's state diagram says any failure short-circuits to `stopping`;
    // without this the event stream just stops and `phase()` lies about an
    // application that has already exited.
  ).tapFailure(() => {
    tracker.advanceTo("stopping");
    tracker.advanceTo("exited");
  });

  return {
    exited,
    stop: () => shutdown.resolve("runtimeStopped"),
    phase: tracker.current,
  };
};
