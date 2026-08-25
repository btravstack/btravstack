import { Config, ConfigInvalid, Env, type Environment } from "@btravstack/config";
import {
  Module,
  Provider,
  type AnyModule,
  type Context,
  type Scope,
  type ScopedOptions,
} from "@btravstack/di";
import { fromSafePromise, Ok, OkAsync, P, type AsyncResult, type Result } from "unthrown";

import { systemClock, type Clock } from "./clock.js";
import { createDeferred } from "./deferred.js";
import { drainApp, type DrainReport } from "./drain.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { createPhaseTracker, type Phase } from "./phase.js";
import { startProbeServer } from "./probes.js";
import { installSignalHandlers, installUncaughtHandlers } from "./process-handlers.js";
import {
  RuntimePort,
  RuntimeStartFailed,
  type RunUnit,
  type Runtime,
  type RuntimeInfoOf,
  type RuntimeInstance,
  type RuntimeResolvesOf,
  type Serving,
} from "./runtime.js";
import { createUnitRegistry } from "./units.js";

export type TeardownError = { readonly port: string; readonly cause: unknown };

const providesEnv = (module: AnyModule): boolean =>
  module.provides.some((provider) => provider.port.portId === Env.portId) ||
  module.imports.some(providesEnv);

export type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined;
  readonly teardownErrors: readonly TeardownError[];
  readonly uptimeMs: number;
};

export type StartOptions<UnitX = never, UnitNeeds = never> = {
  /**
   * The environment the graph is configured from, provided to it as the `Env`
   * port and read for the kernel's own `PROBE_PORT`. Defaults to
   * `process.env`.
   */
  readonly env?: Environment;
  /**
   * A module forked around **every unit**: built as the unit opens, torn down
   * as it closes — while the unit's ambient record is still open — reading
   * anything the application context carries.
   *
   * A failing unit finaliser is reported as a `teardownError` event and never
   * in `ExitReport.teardownErrors`. With this option the unit's work runs only
   * once the fork is built, so a runtime that subscribes to an event from
   * inside its work must be ready for it to have already fired.
   */
  readonly unit?: Module<UnitX, never, UnitNeeds>;
  readonly clock?: Clock;
  readonly signals?: boolean;
  /**
   * The probe server's port. Unset, it is bound from `PROBE_PORT` in `env`
   * (default `9000`); `false` disables the probe server.
   */
  readonly probes?: { readonly port: number } | false;
  readonly preDrainDelayMs?: number;
  readonly drainTimeoutMs?: number;
  readonly onEvent?: EventSink;
};

export type RunningApp<E, Info = never> = {
  readonly exited: AsyncResult<ExitReport, E | RuntimeStartFailed>;
  readonly stop: () => void;
  readonly requestDrain: () => void;
  readonly phase: () => Phase;
  /**
   * The predicate `/readyz` answers from — serving, and not forced unready by
   * a drain or an uncaught exception — read synchronously, which the probe
   * endpoint is not.
   */
  readonly ready: () => boolean;
  /**
   * The port the probe server actually bound, once the bind attempt has
   * settled; `undefined` when probes are disabled or the bind failed.
   */
  readonly probePort: () => AsyncResult<number | undefined, never>;
  /**
   * Whatever the runtime published on `Serving.info` once it is serving;
   * `undefined` when it publishes nothing or never reached `serving`.
   */
  readonly runtimeInfo: () => AsyncResult<Info | undefined, never>;
};

/**
 * The phantom marker `start`, `runMain` and `Boot` all intersect onto their
 * `module` parameter: `unknown` — and invisible — when the module exports a
 * runtime, its exports cover what that runtime resolves and they cover the
 * unit module's needs; one of three sentences otherwise, printed at the call
 * site as the parameter type the argument did not match.
 *
 * `unknown` is the satisfied arm because intersecting it leaves the module
 * type untouched. A runtime's `resolves` is checked against the module's
 * exports only, never the unit module's: `RuntimeHost.ctx` is the application
 * context, so a unit-only port would resolve to nothing there.
 */
export type StartGate<X, UnitNeeds = never> = [Extract<X, RuntimeInstance>] extends [never]
  ? "NO RUNTIME — the module exports no port declared over RuntimePort"
  : [InstanceType<RuntimeResolvesOf<X>>] extends [X]
    ? [Exclude<UnitNeeds, X | Scope | Env>] extends [never]
      ? unknown
      : "UNSATISFIED UNIT NEEDS — the unit module needs a port the module does not export"
    : "UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export";

export const start = <X, E, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, Scope | Env> & StartGate<X, UnitNeeds>,
  options: StartOptions<UnitX, UnitNeeds> = {},
): RunningApp<E, RuntimeInfoOf<X>> => {
  type Info = RuntimeInfoOf<X>;
  type Resolves = RuntimeResolvesOf<X>;
  const clock = options.clock ?? systemClock;
  const env = options.env ?? process.env;
  const emit = safeSink(options.onEvent ?? stderrSink);
  // Known only once the graph is built — the runtime is one of its services.
  let runtimeName = "";
  const tracker = createPhaseTracker((phase) => {
    if (phase === "serving") emit({ type: "serving", runtime: runtimeName });
    if (phase === "stopping") emit({ type: "stopping" });
    if (phase === "exited") emit({ type: "exited" });
  });

  const registry = createUnitRegistry();
  const shutdown = createDeferred<ExitReport["reason"]>();
  const teardownErrors: TeardownError[] = [];
  const startedAt = clock.now();
  const preDrainDelayMs = options.preDrainDelayMs ?? 5_000;
  const drainTimeoutMs = options.drainTimeoutMs ?? 20_000;
  const skipDrain = new AbortController();
  let shutdownRequestedAt = startedAt;
  let shutdownRequested = false;
  const sinceShutdownRequested = (): number => clock.now() - shutdownRequestedAt;
  const requestShutdown = (reason: ExitReport["reason"]): void => {
    if (!shutdownRequested) {
      shutdownRequested = true;
      shutdownRequestedAt = clock.now();
    }
    shutdown.resolve(reason);
  };
  let forcedUnready = false;
  const onUnready = (): void => {
    forcedUnready = true;
  };
  const live = (): boolean => tracker.current() !== "exited";
  // `!forcedUnready` is load-bearing on the uncaught path alone — every drain
  // test passes without it, since there the phase term already answers false.
  const ready = (): boolean => tracker.current() === "serving" && !forcedUnready;
  const disposeSignals =
    options.signals === false
      ? () => {}
      : installSignalHandlers({
          onFirst: () => requestShutdown("signal"),
          onSecond: () => skipDrain.abort(),
        });
  const disposeUncaught =
    options.signals === false
      ? () => {}
      : installUncaughtHandlers((cause) => {
          emit({ type: "uncaught", cause });
          onUnready();
          skipDrain.abort();
          requestShutdown("uncaught");
        });
  let disposeProbes = (): void => {};
  const probeBound = createDeferred<number | undefined>();
  const runtimePublished = createDeferred<Info | undefined>();

  emit({ type: "building" });

  const probesOptions: Result<{ readonly port: number } | false, RuntimeStartFailed> =
    options.probes === undefined
      ? Config.port("PROBE_PORT", { default: 9000 })
          .parse(env["PROBE_PORT"])
          .map((port) => ({ port }))
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("ConfigFieldInvalid"),
              ({ reason }) =>
                new RuntimeStartFailed({
                  runtime: "probes",
                  cause: new ConfigInvalid({
                    port: "probes",
                    issues: [{ message: reason, path: ["PROBE_PORT"] }],
                  }),
                }),
            ),
          )
      : Ok(options.probes);
  if (options.probes === false) probeBound.resolve(undefined);

  const probesStarted: AsyncResult<void, RuntimeStartFailed> = probesOptions
    .toAsync()
    .flatMap((probes) =>
      probes === false
        ? OkAsync()
        : startProbeServer({ port: probes.port, live, ready })
            .tap((server) => {
              probeBound.resolve(server.port);
              disposeProbes = () => {
                // Never awaited: `close` waits out live keep-alive connections,
                // which would delay or strand the exit report.
                void server.close();
              };
            })
            .discard(),
    )
    .tapFailure((failure) => {
      emit({ type: "startFailed", cause: failure.tag === "Err" ? failure.error : failure.cause });
      probeBound.resolve(undefined);
      runtimePublished.resolve(undefined);
      tracker.advanceTo("stopping");
      disposeSignals();
      disposeUncaught();
      tracker.advanceTo("exited");
    });

  const root = Module("Kernel")({
    imports: providesEnv(module)
      ? [module]
      : [
          module,
          Module("Environment")({ provides: [Provider(Env)({ value: env })], exports: [Env] }),
        ],
    exports: [module],
    // Both casts: di's `needs` gate defers while `X` is a type parameter, and
    // no object literal satisfies a deferred conditional. It is discharged in
    // fact — `Env` is what this wrapper provides, `Scope` what the entry point
    // opens.
  } as never) as unknown as Module<X, E, Scope>;

  const runDrain = (serving: Serving<Info>): AsyncResult<DrainReport, never> => {
    tracker.advanceTo("draining");
    emit({ type: "draining", inFlight: registry.inFlight() });

    return drainApp({
      serving,
      registry,
      clock,
      preDrainDelayMs: Math.max(0, preDrainDelayMs - sinceShutdownRequested()),
      drainTimeoutMs,
      skip: skipDrain.signal,
      onUnready,
    }).tap((report) => emit({ type: "drained", report }));
  };

  const finish = (
    serving: Serving<Info>,
    reason: ExitReport["reason"],
  ): AsyncResult<ExitReport, never> => {
    // Skipping the drain means not WAITING for in-flight work, not leaving it
    // running unsignalled: these paths have no deadline, so they abort at once.
    if (reason !== "signal") registry.abortAll();

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
          // The aliasing is LOAD-BEARING: di closes the scope after this object
          // is built, so a defensive copy would drop every teardown error.
          teardownErrors,
          uptimeMs: clock.now() - startedAt,
        };
      });
    });
  };

  const exited = probesStarted.flatMap(() =>
    Module.scoped(
      root,
      (ctx: Context<X>): AsyncResult<ExitReport, RuntimeStartFailed> => {
        tracker.advanceTo("starting");

        // Both casts restate, where the checker cannot see it, what the
        // `StartGate` proved at the call site: a port with `RuntimePort`'s id
        // is exported, and the exports cover what the runtime resolves.
        const runtime = (ctx as unknown as Context<RuntimeInstance>).get(
          RuntimePort as unknown as abstract new () => RuntimeInstance,
        ) as Runtime<Resolves, Info>;
        runtimeName = runtime.name;

        const runtimeCtx = ctx as unknown as Context<InstanceType<Resolves>>;

        // The fork sits INSIDE `registry.run` so unit teardown still sees the
        // ambient record and the unit is not counted closed until the scope is.
        const unit = options.unit;
        const run: RunUnit<Resolves> = (meta, work) =>
          registry.run(meta, (signal) => {
            if (unit === undefined) return work(runtimeCtx, signal);

            const fork = Module.forkScope as <T, Err>(
              parent: Context<X>,
              module: Module<UnitX, never, UnitNeeds>,
              use: (forked: Context<X | UnitX>) => AsyncResult<T, Err>,
              options: ScopedOptions,
            ) => AsyncResult<T, Err>;

            return fork(
              ctx,
              unit,
              (forked) =>
                fromSafePromise(
                  (async () => await work(forked as Context<InstanceType<Resolves>>, signal))(),
                ).flatMap((result) => result),
              { onTeardownError: (port, cause) => emit({ type: "teardownError", port, cause }) },
            ) as ReturnType<typeof work>;
          });

        const host = { ctx: runtimeCtx, run };

        return runtime.start(host).flatMap((serving: Serving<Info>) => {
          tracker.advanceTo("serving");
          runtimePublished.resolve(serving.info);

          return fromSafePromise(shutdown.promise).flatMap((reason) => finish(serving, reason));
        });
      },
      {
        onTeardownError: (port, cause) => {
          teardownErrors.push({ port, cause });
          emit({ type: "teardownError", port, cause });
        },
      },
    ).tapFailure((failure) => {
      // Reaching here past `stopping` is a shutdown defect, not a startup one.
      if (tracker.current() !== "stopping") {
        emit({ type: "startFailed", cause: failure.tag === "Err" ? failure.error : failure.cause });
      }
      runtimePublished.resolve(undefined);
      tracker.advanceTo("stopping");
      disposeSignals();
      disposeUncaught();
      tracker.advanceTo("exited");
      disposeProbes();
    }),
  );

  return {
    exited,
    stop: () => requestShutdown("runtimeStopped"),
    requestDrain: () => requestShutdown("signal"),
    phase: tracker.current,
    ready,
    probePort: () => fromSafePromise(probeBound.promise),
    runtimeInfo: () => fromSafePromise(runtimePublished.promise),
  };
};
