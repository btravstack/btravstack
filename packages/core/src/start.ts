import { Config, ConfigInvalid, Env, type ConfigIssue, type Environment } from "@btravstack/config";
import {
  Module,
  Provider,
  type AnyModule,
  type Context,
  type Scope,
  type ScopedOptions,
} from "@btravstack/di";
import { Err, fromSafePromise, Ok, OkAsync, type AsyncResult, type Result } from "unthrown";

import { systemClock, type Clock } from "./clock.js";
import { drainApp, type DrainReport } from "./drain.js";
import { safeSink, stderrSink, type EventSink } from "./events.js";
import { HealthChecks, runHealthChecks, type HealthCheck, type HealthReport } from "./health.js";
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

/**
 * What the kernel reads from the environment for itself. Each field is pinned
 * by the matching `StartOptions` field — explicit beats environment beats
 * default, per field, exactly as a starter's own configuration is.
 */
const KERNEL_DEFAULTS = {
  probePort: 9000,
  preDrainDelayMs: 5_000,
  drainTimeoutMs: 20_000,
} as const;

type KernelConfig = { readonly [K in keyof typeof KERNEL_DEFAULTS]: number };

const readKernelConfig = (
  options: Pick<StartOptions<never, never>, "probes" | "preDrainDelayMs" | "drainTimeoutMs">,
  env: Environment,
): Result<KernelConfig, RuntimeStartFailed> => {
  // `probes: false` pins the default and so reads nothing: a deployment that
  // disabled the probe server should not fail on its port.
  const probePort =
    options.probes === undefined
      ? undefined
      : options.probes === false
        ? KERNEL_DEFAULTS.probePort
        : options.probes.port;
  const schema = Config.object({
    probePort: Config.pinned(
      probePort,
      Config.port("PROBE_PORT", { default: KERNEL_DEFAULTS.probePort }),
    ),
    preDrainDelayMs: Config.pinned(
      options.preDrainDelayMs,
      Config.integer("PRE_DRAIN_DELAY_MS", { default: KERNEL_DEFAULTS.preDrainDelayMs, min: 0 }),
    ),
    drainTimeoutMs: Config.pinned(
      options.drainTimeoutMs,
      Config.integer("DRAIN_TIMEOUT_MS", { default: KERNEL_DEFAULTS.drainTimeoutMs, min: 0 }),
    ),
  });
  // Synchronous by construction — `Config.object` never defers — so the
  // Promise arm of Standard Schema cannot occur here.
  const result = schema["~standard"].validate(env) as
    | { readonly value: KernelConfig; readonly issues?: undefined }
    | { readonly issues: readonly ConfigIssue[] };
  return result.issues === undefined
    ? Ok(result.value)
    : Err(
        new RuntimeStartFailed({
          runtime: "kernel",
          cause: new ConfigInvalid({ port: "kernel", issues: result.issues }),
        }),
      );
};

export type StartOptions<UnitX = never, UnitNeeds = never> = {
  /**
   * The environment the graph is configured from, provided to it as the `Env`
   * port and read for the kernel's own `PROBE_PORT`. Defaults to
   * `process.env`.
   */
  readonly env?: Environment;
  /**
   * A module forked around **every unit** — a unit being one bounded piece of
   * work, whatever the transport calls it: an HTTP request, a Temporal
   * activity, an AMQP delivery. Built as the unit opens, torn down as it
   * closes — while the unit's ambient record is still open — reading anything
   * the application context carries.
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
  /**
   * How long readiness stays false before the runtime is told to stop
   * accepting. Unset, it is bound from `PRE_DRAIN_DELAY_MS` in `env` (default
   * `5_000`) — the window that covers Kubernetes' eventually-consistent
   * endpoint removal, which is a property of the cluster rather than of the
   * code, so a deployment must be able to set it.
   */
  readonly preDrainDelayMs?: number;
  /**
   * How long in-flight work gets before it is aborted and reported
   * `abandoned`. Unset, it is bound from `DRAIN_TIMEOUT_MS` in `env` (default
   * `20_000`). Keep it under the pod's `terminationGracePeriodSeconds`, which
   * is the reason this one belongs in the environment: the two are set
   * together, in the same manifest.
   */
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
  // Both are on the `serving` event so a `PORT=0` / `PROBE_PORT=0` boot says
  // what it bound. Mirrored into a `let` rather than read off the deferreds
  // because the tracker's callback is synchronous and neither promise has
  // settled by the time it runs.
  let servingInfo: unknown = undefined;
  let probeBoundPort: number | undefined = undefined;
  const tracker = createPhaseTracker((phase) => {
    if (phase === "serving")
      emit({ type: "serving", runtime: runtimeName, info: servingInfo, probePort: probeBoundPort });
    if (phase === "stopping") emit({ type: "stopping" });
    if (phase === "exited") emit({ type: "exited" });
  });

  const registry = createUnitRegistry();
  // `resolve` is idempotent by spec, so the second SIGTERM — and the uncaught
  // handler racing a signal — cannot rewrite the reason an application stopped.
  const shutdown = Promise.withResolvers<ExitReport["reason"]>();
  const teardownErrors: TeardownError[] = [];
  const startedAt = clock.now();
  // One read for every variable the kernel itself owns, so a deployment that
  // got two of them wrong is told both at once. The timings fall back to their
  // defaults when it fails, which changes nothing: the same failure is what
  // `exited` reports, and no drain happens after it.
  const kernelConfig = readKernelConfig(options, env);
  const { preDrainDelayMs, drainTimeoutMs } = kernelConfig.getOrElse(() => KERNEL_DEFAULTS);
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
  // Probes answer from `building` onward, which is BEFORE the graph that
  // declares the checks exists — so the list is late-bound rather than passed
  // in. Until it is filled, `/healthz` reports healthy with no components:
  // "nothing has said otherwise yet" is the honest answer while building.
  let healthChecks: readonly HealthCheck[] = [];
  const health = (): AsyncResult<HealthReport, never> => runHealthChecks(healthChecks);
  const probeBound = Promise.withResolvers<number | undefined>();
  const runtimePublished = Promise.withResolvers<Info | undefined>();

  emit({ type: "building" });

  // Mapped through `kernelConfig` even when probes are off: the read covers
  // the drain timings too, and short-circuiting on `probes: false` would let a
  // malformed `DRAIN_TIMEOUT_MS` boot on the defaults with nothing reported.
  const probesOptions: Result<{ readonly port: number } | false, RuntimeStartFailed> =
    kernelConfig.map(({ probePort }) => (options.probes === false ? false : { port: probePort }));
  if (options.probes === false) probeBound.resolve(undefined);

  const probesStarted: AsyncResult<void, RuntimeStartFailed> = probesOptions
    .toAsync()
    .flatMap((probes) =>
      probes === false
        ? OkAsync()
        : startProbeServer({ port: probes.port, live, ready, health })
            .tap((server) => {
              probeBoundPort = server.port;
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
          Module("Environment")({
            provides: [Provider(Env)({ inject: {}, value: env })],
            exports: [Env],
          }),
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

        // A set port with no contributors resolves to `[]`, so an application
        // that composed no starter declaring a check needs no special case.
        healthChecks = (ctx as unknown as Context<HealthChecks>).get(
          HealthChecks as unknown as abstract new () => HealthChecks,
        );

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
          servingInfo = serving.info;
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
