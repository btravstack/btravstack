import { Module, type AnyPort, type Context, type Scope } from "@btravstack/di";
import { fromSafePromise, OkAsync, type AsyncResult } from "unthrown";

import { systemClock, type Clock } from "./clock.js";
import { createDeferred } from "./deferred.js";
import { drainApp, type DrainReport } from "./drain.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { createPhaseTracker, type Phase } from "./phase.js";
import { startProbeServer } from "./probes.js";
import { installSignalHandlers, installUncaughtHandlers } from "./process-handlers.js";
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
  /**
   * The predicate `/readyz` answers from — serving, and not forced unready by
   * a drain or an uncaught exception.
   *
   * Readable synchronously, which the probe endpoint is not: the uncaught path
   * forces it false while the phase is still `"serving"`, a window no HTTP
   * round trip can observe. Also what an embedder wires into a health endpoint
   * of its own when `probes` is `false`.
   */
  readonly ready: () => boolean;
  /**
   * The port the probe server actually bound, once the bind attempt has
   * settled — `undefined` when probes are disabled or the bind failed.
   *
   * Resolves before the graph is built, since the probe server is up first.
   * The point of it is `probes: { port: 0 }`: the OS picks the port, and this
   * is how the caller learns which one.
   */
  readonly probePort: () => Promise<number | undefined>;
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
  // The second signal aborts this, cutting short whichever `drainApp` sleep
  // (pre-drain delay or drain timeout) is currently pending.
  const skipDrain = new AbortController();
  // Forced false by the drain (before the runtime stops accepting new work)
  // and by an uncaught exception; never reset back to `true` — which is why
  // the setter takes no argument. Hoisted out of `runDrain` so the
  // uncaught-exception path (which skips the drain entirely) can flip it too,
  // through the same mechanism rather than a second one.
  let forcedUnready = false;
  const onUnready = (): void => {
    forcedUnready = true;
  };
  const live = (): boolean => tracker.current() !== "exited";
  // The two terms do NOT contribute equally, and the next person to touch this
  // needs to know which one does the work.
  //
  // On the DRAIN path the phase term alone already answers false: `runDrain`
  // advances the tracker to `"draining"` synchronously *before* `drainApp`
  // calls `onUnready`, and the tracker never returns to `"serving"`. So
  // `!forcedUnready` changes nothing there.
  //
  // The latch is load-bearing on exactly one path — the uncaught-exception
  // one, where the handler flips it while the phase is still `"serving"`,
  // because the tracker only moves once the shutdown promise's continuation
  // runs a tick or more later. Deleting `!forcedUnready` is consequently
  // invisible to every drain test and is caught by exactly one assertion:
  // `invariants.spec.ts`'s "an uncaught exception forces readiness false while
  // the phase is still serving". That test reads `app.ready()` synchronously
  // rather than over HTTP because no round trip fits inside that single tick —
  // which is also why `ready()` is exposed on `RunningApp` at all.
  const ready = (): boolean => tracker.current() === "serving" && !forcedUnready;
  const disposeSignals =
    options.signals === false
      ? () => {}
      : installSignalHandlers({
          onFirst: () => shutdown.resolve("signal"),
          onSecond: () => skipDrain.abort(),
        });
  const disposeUncaught =
    options.signals === false
      ? () => {}
      : installUncaughtHandlers((cause) => {
          emit({ type: "uncaught", cause });
          onUnready();
          skipDrain.abort();
          shutdown.resolve("uncaught");
        });
  // Reassigned once the probe server actually binds (see `probesStarted`
  // below); stays a no-op when probes are disabled or the bind never
  // succeeds, so both dispose sites can call it unconditionally.
  let disposeProbes = (): void => {};
  // Settled exactly once, on every route out of the bind attempt — bound,
  // disabled, or failed — so `probePort()` can never hang.
  const probeBound = createDeferred<number | undefined>();

  emit({ type: "building" });

  // Bound before `Module.scoped` runs, so `/livez` answers while the graph
  // is still building (there is deliberately no separate startup probe —
  // see `probes.ts`). A bind failure is a startup failure of its own: the
  // `tapFailure` here runs the same construction-failure cleanup as
  // `Module.scoped`'s below, since a failed `probesStarted` short-circuits
  // the `flatMap` that would otherwise reach it.
  const probesOptions = options.probes ?? { port: 9000 };
  if (probesOptions === false) probeBound.resolve(undefined);

  const probesStarted: AsyncResult<void, RuntimeStartFailed> = (
    probesOptions === false
      ? OkAsync()
      : startProbeServer({ port: probesOptions.port, live, ready })
          .tap((server) => {
            probeBound.resolve(server.port);
            disposeProbes = () => {
              void server.close();
            };
          })
          .discard()
  ).tapFailure(() => {
    probeBound.resolve(undefined);
    tracker.advanceTo("stopping");
    disposeSignals();
    disposeUncaught();
    tracker.advanceTo("exited");
  });

  // Only a `"signal"` shutdown reason drains. `"runtimeStopped"` (plain
  // `stop()`) and `"uncaught"` go straight to `stopping`, leaving
  // `ExitReport.drain` `undefined` — draining after an uncaught exception
  // risks completing in-flight work against corrupted state.
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
      onUnready,
    }).tap((report) => emit({ type: "drained", report }));
  };

  const finish = (
    serving: Serving,
    reason: ExitReport["reason"],
  ): AsyncResult<ExitReport, never> => {
    const drained: AsyncResult<DrainReport | undefined, never> =
      reason === "signal" ? runDrain(serving) : OkAsync<DrainReport | undefined>(undefined);

    return drained.flatMap((report) => {
      tracker.advanceTo("stopping");

      return serving.stop().map(() => {
        disposeSignals();
        disposeUncaught();
        tracker.advanceTo("exited");
        disposeProbes();
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

  const exited = probesStarted.flatMap(() =>
    Module.scoped(
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
      disposeSignals();
      disposeUncaught();
      tracker.advanceTo("exited");
      disposeProbes();
    }),
  );

  return {
    exited,
    stop: () => shutdown.resolve("runtimeStopped"),
    requestDrain: () => shutdown.resolve("signal"),
    phase: tracker.current,
    ready,
    probePort: () => probeBound.promise,
  };
};
