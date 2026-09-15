import { Config, ConfigInvalid, Env, type ConfigIssue, type Environment } from "@btravstack/config";
import {
  Module,
  Provider,
  type AnyModule,
  type Context,
  type PortInstance,
  type Scope,
} from "@btravstack/di";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

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
  type UnitHost,
} from "./runtime.js";
import { createUnitRegistry } from "./units.js";

export type TeardownError = { readonly port: string; readonly cause: unknown };

/**
 * An arm of a race that has lost and has nothing to report: it never settles,
 * so the winner decides. It holds no timer and no handle, which is what makes
 * it safe — the alternative is an arm that answers a report no consumer reads,
 * and whose side effects then have to be guarded one by one.
 */
const withdrawn = <T>(): AsyncResult<T, never> => fromSafePromise(new Promise<T>(() => {}));

const providesEnv = (module: AnyModule): boolean =>
  module.provides.some((provider) => provider.port.portId === Env.portId) ||
  module.imports.some(providesEnv);

export type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined;
  readonly teardownErrors: readonly TeardownError[];
  readonly uptimeMs: number;
  /**
   * Set when the kernel stopped WAITING for a phase that has no deadline of its
   * own — `"stop"` for a `Serving.stop` or a finaliser still running at
   * `stopTimeoutMs`, `"build"` for a graph abandoned before it ever served.
   *
   * It is "stopped waiting", not "cancelled": nothing here can cancel a
   * finaliser, so a wedged one can still hold the event loop past this report
   * and end in SIGKILL. What the field buys is that the report EXISTS and says
   * which phase ran long — where the alternative was a process stuck in
   * `stopping` with no event, no code and no exit report at all.
   */
  readonly abandonedAt?: "build" | "stop";
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
  stopTimeoutMs: 5_000,
} as const;

type KernelConfig = { readonly [K in keyof typeof KERNEL_DEFAULTS]: number };

const readKernelConfig = (
  options: Pick<StartOptions, "probes" | "preDrainDelayMs" | "drainTimeoutMs" | "stopTimeoutMs">,
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
    stopTimeoutMs: Config.pinned(
      options.stopTimeoutMs,
      Config.integer("STOP_TIMEOUT_MS", { default: KERNEL_DEFAULTS.stopTimeoutMs, min: 0 }),
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

export type StartOptions = {
  /**
   * The environment the graph is configured from, provided to it as the `Env`
   * port and read for the kernel's own `PROBE_PORT`. Defaults to
   * `process.env`.
   */
  readonly env?: Environment;
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
  /**
   * How long the kernel waits for `Serving.stop` and the application scope's
   * finalisers together before it stops waiting and reports
   * `ExitReport.abandonedAt: "stop"`. Unset, it is bound from
   * `STOP_TIMEOUT_MS` in `env` (default `5_000`).
   *
   * It exists because beat 3's deadline covers in-flight WORK and nothing
   * covered the teardown: a `release` that never settles — a socket to a host
   * that stopped answering — left the phase at `stopping` with no exit report,
   * which is the one artefact the lifecycle exists to produce. The three
   * timings are cumulative against the pod's
   * `terminationGracePeriodSeconds`, so the defaults sum to 30 s exactly
   * (`5_000 + 20_000 + 5_000`): raise one and raise the grace period with it.
   */
  readonly stopTimeoutMs?: number;
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
 * `module` parameter: `unknown` — and invisible — when nothing the module
 * needs is unprovided, it exports a runtime and its exports cover what that
 * runtime resolves; a diagnostic otherwise, printed at the call site as the
 * parameter type the argument did not match.
 *
 * `unknown` is the satisfied arm because intersecting it leaves the module
 * type untouched. A runtime's `resolves` is checked against the module's
 * exports only: `RuntimeHost.ctx` is the application context, so a port only
 * a `fork` provides would resolve to nothing there. A `fork`'s own needs are
 * not this marker's business at all — a `fork` module is forked over the
 * application context, so its needs are exactly what a starter's own `needs`
 * channel already asks the composition root to supply, and di's ordinary
 * `UNSATISFIED DEPENDENCIES` gate is what refuses a root that does not.
 *
 * **Unmet needs are checked FIRST, and answered in di's own words rather than
 * a sentence of the kernel's.** A root that forgot `provides: [router]` used
 * to be told `Type 'HttpRouterPort' is not assignable to type 'Scope'` — an
 * internal phantom nobody has heard of — or, when the port was missing from
 * `exports` too, `UNSATISFIED RUNTIME PORTS`, which is a correct diagnosis of
 * the second mistake that reads as a wrong one of the first and steers the fix
 * into the wrong list. It is the same defect `Module.build` reports, so it
 * prints the same sentence and ends on the port that is missing.
 */
/**
 * A port's declared id, which is what a marker names it by: an id is the short
 * string the application wrote in `Port("…")`, where the port TYPE of a
 * starter's own generic port — `AmqpHandlers` over a contract — expands to
 * hundreds of characters of the caller's own schema and truncates before the
 * name is reached.
 */
type PortIdOf<P> = P extends PortInstance<infer Id, infer _Service> ? Id : P;

export type StartGate<X, N = never> = [Exclude<N, Scope | Env>] extends [never]
  ? [Extract<X, RuntimeInstance>] extends [never]
    ? "NO RUNTIME — the module exports no port declared over RuntimePort"
    : [InstanceType<RuntimeResolvesOf<X>>] extends [X]
      ? unknown
      : "UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"
  : { readonly "UNSATISFIED DEPENDENCIES — nothing provides": PortIdOf<Exclude<N, Scope | Env>> };

export const start = <X, E, N>(
  module: Module<X, E, N> & StartGate<X, N>,
  options: StartOptions = {},
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
  const { preDrainDelayMs, drainTimeoutMs, stopTimeoutMs } = kernelConfig.getOrElse(
    () => KERNEL_DEFAULTS,
  );
  const skipDrain = new AbortController();
  // Cuts the stop wait short: aborted when the stop settles on its own (so the
  // timer is not left armed) and by a second signal, which means "stop waiting"
  // about the teardown exactly as it already does about the drain.
  const stopSettled = new AbortController();
  // Set when the WHOLE scoped call settles — `Serving.stop` *and* di's
  // finalisers — which is strictly later than `finish`'s own `.map`, and that
  // gap is the bug this whole deadline exists for: a `release` that never
  // settles leaves `finish` having returned a report that nothing can read,
  // because `Module.scoped` has not settled to hand it over. Guarding the
  // deadline on the phase, or on `serving.stop()` alone, reinstates exactly
  // that hole.
  let lifecycleSettled = false;
  const onLifecycleSettled = (): void => {
    lifecycleSettled = true;
    stopSettled.abort();
  };
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
          // "Stop waiting", applied to every wait there is: the drain's two
          // sleeps, the teardown's, and a build that has not served — where the
          // first signal is deliberately buffered and would otherwise leave a
          // hung boot with nothing an operator can do but SIGKILL.
          onSecond: () => {
            skipDrain.abort();
            stopSettled.abort();
            abandonBuild("signal");
          },
        });
  const disposeUncaught =
    options.signals === false
      ? () => {}
      : installUncaughtHandlers((cause) => {
          emit({ type: "uncaught", cause });
          onUnready();
          skipDrain.abort();
          requestShutdown("uncaught");
          // A crash mid-build reaches no `finish`, and installing the handler
          // has already suppressed Node's own exit `1` — so without this the
          // process absorbs its own crash: no code, no report, nothing.
          abandonBuild("uncaught");
        });
  let disposeProbes = (): void => {};
  // One place, because three paths out now reach it: `finish`, the abandoned
  // stop and the abandoned build. The order is load-bearing only in that the
  // handlers go before `exited`, so a signal arriving during the last tick of
  // a shutdown cannot re-enter a lifecycle that has already reported.
  const disposeAll = (): void => {
    disposeSignals();
    disposeUncaught();
    tracker.advanceTo("exited");
    disposeProbes();
  };
  const reportOf = (
    reason: ExitReport["reason"],
    drain: DrainReport | undefined,
    abandonedAt?: "build" | "stop",
  ): ExitReport => ({
    reason,
    drain,
    // The aliasing is LOAD-BEARING: di closes the scope after this object is
    // built, so a defensive copy would drop every teardown error. On the
    // abandoned-stop path the close is still running, so the array may still
    // grow after a reader has the report — which is the same property, not a
    // new hazard.
    teardownErrors,
    uptimeMs: clock.now() - startedAt,
    ...(abandonedAt === undefined ? {} : { abandonedAt }),
  });
  // Probes answer from `building` onward, which is BEFORE the graph that
  // declares the checks exists — so the list is late-bound rather than passed
  // in. Until it is filled, `/healthz` reports healthy with no components:
  // "nothing has said otherwise yet" is the honest answer while building.
  let healthChecks: readonly HealthCheck[] = [];
  const health = (): AsyncResult<HealthReport, never> => runHealthChecks(healthChecks);
  const probeBound = Promise.withResolvers<number | undefined>();
  const runtimePublished = Promise.withResolvers<Info | undefined>();

  // The two phases with no deadline of their own, each as an arm of the race
  // that produces `exited` below. Both are CONSUMED there rather than floated,
  // and both are armed by a deferred that stays pending on the ordinary path —
  // so an application that stops cleanly starts neither timer.
  const stopping = Promise.withResolvers<{
    readonly reason: ExitReport["reason"];
    readonly drain: DrainReport | undefined;
  }>();
  // `Serving.stop` AND di's scope close, together: the close runs after
  // `finish` has returned, inside `Module.scoped`, so a race inside `finish`
  // could only ever have covered the first half — and the finalisers are the
  // half that hangs (a pool draining to a host that stopped answering).
  //
  // A THUNK, not a value, and both arms below match it: an `AsyncResult` is
  // eager, so constructing one here would start it beside the other two rather
  // than as part of the race that consumes it.
  const stopAbandoned = (): AsyncResult<ExitReport, never> =>
    fromSafePromise(stopping.promise).flatMap(({ reason, drain }) =>
      clock.sleep(stopTimeoutMs, stopSettled.signal).flatMap(() =>
        // `clock.sleep` RESOLVES when its signal aborts — that is how the
        // drain's two sleeps are cut short — and a settled lifecycle aborts
        // this one. So reaching here says nothing on its own:
        // `lifecycleSettled` is what tells a deadline from a shutdown that
        // completed, and reading the signal instead reported a timeout on
        // every clean stop (measured, by writing it that way first).
        lifecycleSettled ? withdrawn<ExitReport>() : OkAsync(abandonStop(reason, drain)),
      ),
    );

  const abandonStop = (
    reason: ExitReport["reason"],
    drain: DrainReport | undefined,
  ): ExitReport => {
    emit({
      type: "stoppedWaiting",
      phase: "stop",
      // A second signal cut the wait short, so the deadline is not what ended
      // it and naming one would be a small lie.
      afterMs: stopSettled.signal.aborted ? undefined : stopTimeoutMs,
    });
    disposeAll();
    return reportOf(reason, drain, "stop");
  };

  const abandoningBuild = Promise.withResolvers<ExitReport["reason"]>();
  // A shutdown requested before the runtime serves has no `finish` to reach:
  // `shutdown.promise` is read inside `runtime.start`'s own `flatMap`, which a
  // graph that never finished building never reaches — and the handlers have
  // already suppressed Node's own exit, so the event was absorbed entirely.
  // Only an UNCAUGHT exception or a SECOND signal comes here; a first signal
  // mid-build stays buffered and drains once serving, which is the tested
  // behaviour `preDrainDelayMs`'s arithmetic depends on.
  const buildAbandoned = (): AsyncResult<ExitReport, never> =>
    fromSafePromise(abandoningBuild.promise).map((reason) => {
      emit({ type: "stoppedWaiting", phase: "build", afterMs: undefined });
      registry.abortAll();
      // The same two lines every other route out of a half-built graph runs —
      // the probe bind's `tapFailure` and `Module.scoped`'s. `stopping` before
      // `exited` because the tracker is monotonic and skipping it would drop
      // the phase, and its event, out of a lifecycle that documents both as
      // reached on every path; `runtimePublished` because `runtimeInfo()`
      // promises `undefined` for a runtime that never served, and this route
      // leaves `Module.scoped` pending forever, so the `tapFailure` that
      // usually settles it never runs.
      runtimePublished.resolve(undefined);
      tracker.advanceTo("stopping");
      disposeAll();
      return reportOf(reason, undefined, "build");
    });
  const abandonBuild = (reason: ExitReport["reason"]): void => {
    const phase = tracker.current();
    if (phase === "building" || phase === "starting") abandoningBuild.resolve(reason);
  };

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
      // Arms `stopAbandoned`, the other arm of the race that settles `exited`.
      // Synchronous with the phase change, so the deadline covers the whole of
      // `stopping` — `serving.stop()` here and the finalisers di runs after
      // this callback returns.
      stopping.resolve({ reason, drain: report });

      // No `onLifecycleSettled` here, deliberately: di closes the scope after
      // this callback returns, so the stop is only half over.
      return serving.stop().map(() => {
        disposeAll();
        return reportOf(reason, report);
      });
    });
  };

  const built = (): AsyncResult<ExitReport, E | RuntimeStartFailed> =>
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
        const run: RunUnit<Resolves> = (meta, work) =>
          registry.run(meta, (signal) => {
            const settled = Promise.withResolvers<void>();
            let closing: Promise<unknown> | undefined;
            // Set in the SAME `finally` that resolves `settled`, not derived
            // from it: a fork arriving after `work` has returned is not
            // awaited by anything, so nothing supervises its scope or its
            // `onStop` — unsupervised is unsupervised whether or not this
            // unit ever forked at all, which is why this guard is separate
            // from `closing`'s own "once" one below.
            let hasSettled = false;

            const fork: UnitHost<Resolves>["fork"] = (module, seed) => {
              if (hasSettled) {
                return fromSafePromise(
                  Promise.reject(new Error("a unit forks after it has already settled")),
                ) as never;
              }
              if (closing !== undefined) {
                return fromSafePromise(
                  Promise.reject(new Error("a unit forks its scope once")),
                ) as never;
              }
              const ready = Promise.withResolvers<Context<never>>();
              // `use` resolves the context to the caller and then holds the
              // scope open until the unit settles; that is what keeps the
              // teardown inside the unit rather than at the handler's return.
              // Cast to `AsyncResult<void, never>`: `module as never` erases
              // the modeled error channel from `forkScope`'s own inference,
              // but the `fork` signature already proves it is `never`.
              const scope = Module.forkScope(
                ctx as Context<never>,
                module as never,
                (forked) => {
                  ready.resolve(forked);
                  return fromSafePromise(settled.promise);
                },
                {
                  seed: seed as never,
                  onTeardownError: (port, cause) => emit({ type: "teardownError", port, cause }),
                },
              ) as unknown as AsyncResult<void, never>;
              // Construction failed before `use` ran: release the caller
              // onto the defect path instead of leaving it waiting. The
              // module's error channel is `never`, so a defect is the only
              // failure a fork can have.
              closing = scope
                .recoverDefect((cause) => {
                  ready.reject(cause);
                  return Ok();
                })
                .get();
              return fromSafePromise(ready.promise) as never;
            };

            const outcome = (async () => {
              try {
                return await work({ ctx: runtimeCtx, fork }, signal);
              } finally {
                hasSettled = true;
                settled.resolve();
                if (closing !== undefined) await closing;
              }
            })();
            return fromSafePromise(outcome).flatMap((result) => result) as ReturnType<typeof work>;
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
    )
      .tapFailure((failure) => {
        // Reaching here past `stopping` is a shutdown defect, not a startup one.
        if (tracker.current() !== "stopping") {
          emit({
            type: "startFailed",
            cause: failure.tag === "Err" ? failure.error : failure.cause,
          });
        }
        runtimePublished.resolve(undefined);
        tracker.advanceTo("stopping");
        disposeAll();
      })
      // Both channels, because either settling means the deadline has nothing
      // left to report: the arm withdraws rather than writing a line 5 s after
      // the process already said how it ended.
      .tap(onLifecycleSettled)
      .tapFailure(onLifecycleSettled) as AsyncResult<ExitReport, E | RuntimeStartFailed>;

  // The three ways a lifecycle ends, raced: the graph settling on its own, the
  // teardown running past its deadline, and a build nothing will finish. The
  // losing branches' `Result`s are DROPPED, which is `releasedBy`'s own
  // bargain one layer up — once a report has been handed to `runMain` the
  // outcome of a finaliser still running has no consumer left. Both abandon
  // arms stay pending on the ordinary path, so a clean stop races nothing and
  // arms no timer.
  const exited = probesStarted.flatMap(() =>
    fromSafePromise(Promise.race([built(), stopAbandoned(), buildAbandoned()])).flatMap(
      (settled) => settled,
    ),
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
