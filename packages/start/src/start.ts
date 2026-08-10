import { Module, type AnyPort, type Context, type Scope } from "@btravstack/di";
import { fromSafePromise, Ok, type AsyncResult } from "unthrown";

import { systemClock, type Clock } from "./clock.js";
import { createDeferred } from "./deferred.js";
import type { DrainReport } from "./drain-report.js";
import { drainApp } from "./drain.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { createPhaseTracker, type Phase } from "./phase.js";
import type { RunUnit, Runtime, RuntimeStartFailed, Serving } from "./runtime.js";
import { createUnitRegistry } from "./units.js";

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
  readonly requestDrain: () => void;
  readonly phase: () => Phase;
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
  const preDrainDelayMs = options.preDrainDelayMs ?? 5_000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 20_000;
  // Nothing aborts this yet — Task 9's second-signal fast path will, to cut a
  // slow drain short.
  const skipDrain = new AbortController();

  emit({ type: "building" });

  // Only a `"signal"` shutdown reason drains. `"runtimeStopped"` (plain
  // `stop()`) and `"uncaught"` (Task 10) go straight to `stopping`, leaving
  // `ExitReport.drain` `undefined`.
  const runDrain = (serving: Serving): AsyncResult<DrainReport, never> => {
    tracker.advanceTo("draining");
    emit({ type: "draining", inFlight: registry.inFlight() });

    return drainApp({
      serving,
      registry,
      clock,
      preDrainDelayMs,
      drainTimeoutMs,
      skip: skipDrain.signal,
      // Task 11 wires this into the probe server's readiness endpoint.
      onReadyChange: () => {},
    }).tap((report) => emit({ type: "drained", report }));
  };

  const finish = (
    serving: Serving,
    reason: ExitReport["reason"],
  ): AsyncResult<ExitReport, never> => {
    const drained: AsyncResult<DrainReport | undefined, never> =
      reason === "signal" ? runDrain(serving) : Ok<DrainReport | undefined>(undefined).toAsync();

    return drained.flatMap((report) => {
      tracker.advanceTo("stopping");

      return serving.stop().map(() => {
        tracker.advanceTo("exited");
        return {
          reason,
          drain: report,
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
    });
  };

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

        return fromSafePromise(shutdown.promise).flatMap((reason) => finish(serving, reason));
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
    requestDrain: () => shutdown.resolve("signal"),
    phase: tracker.current,
  };
};
