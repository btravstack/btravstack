import { Module, type AnyPort, type Context, type Scope } from "@btravstack/di";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { systemClock, type Clock } from "./clock.js";
import { createDeferred } from "./deferred.js";
import type { DrainReport } from "./drain-report.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { createPhaseTracker, type Phase, type PhaseTracker } from "./phase.js";
import type { RunUnit, Runtime, RuntimeStartFailed, Serving } from "./runtime.js";
import { createUnitRegistry, type UnitMeta, type UnitRegistry, type UnitWork } from "./units.js";

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
export const start = <X, E, Needs extends AnyPort>(
  module: Module<X, E, Scope>,
  options: StartOptions<Needs>,
): RunningApp<E> => {
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
      // exports cover the runtime's needs is assignable here; the cast is only
      // because `X` and `Needs` are unrelated type parameters at this point,
      // and the assignability is enforced at the public `start` call.
      const runtimeCtx = ctx as unknown as Context<Needs>;

      // The registry counts and aborts; it knows nothing about contexts. The
      // kernel is what closes over `runtimeCtx` and hands a runtime the
      // two-argument `RunUnit` its handlers expect. When the `unit` module
      // lands (deferred, see the end of this plan), the `Module.forkScope`
      // call goes exactly here, replacing `runtimeCtx` with the fork's context.
      const run = (<T, E2>(
        meta: UnitMeta,
        work: (c: Context<Needs>, signal: AbortSignal) => ReturnType<UnitWork<T, E2>>,
      ) => registry.run<T, E2>(meta, (signal) => work(runtimeCtx, signal))) as RunUnit<Needs>;

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
  );

  return {
    exited,
    stop: () => shutdown.resolve("runtimeStopped"),
    phase: tracker.current,
  };
};
