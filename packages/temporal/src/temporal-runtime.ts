import { Config, type ConfigInvalid, type Env } from "@btravstack/config";
import {
  RuntimePort,
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/core";
import { Module, Port, Provider, type AnyPort, type Scope, type ServiceOf } from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";
import {
  declareActivitiesHandler,
  type DeclareActivitiesHandlerOptions,
} from "@temporal-contract/worker/activity";
import type { Duration } from "@temporalio/common";
import { NativeConnection, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import {
  OkAsync,
  TaggedError,
  fromPromise,
  fromSafePromise,
  fromThrowable,
  type AsyncResult,
} from "unthrown";

import { activityUnits } from "./activity-units.js";

/** What the worker publishes once it is polling, read back through `RunningApp.runtimeInfo()`. */
export type TemporalInfo = {
  readonly taskQueue: string;
  readonly namespace: string;
};

/**
 * Where the workflow sandbox's code comes from. Two arms because the two
 * callers genuinely differ: a process points at the module and lets Temporal
 * bundle it, while a spec hands over a bundle it built and memoised once —
 * bundling per test is the most expensive thing a suite does.
 */
export type WorkflowSource =
  | { readonly workflowsPath: string }
  | { readonly workflowBundle: WorkflowBundleWithSourceMap };

/**
 * Where the Temporal service is, as a service: `temporal()` binds it from the
 * environment — `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`) and
 * `TEMPORAL_NAMESPACE` (default `default`) — unless pinned, and anything else
 * in the graph may read it.
 */
export class TemporalConfig extends Port("TemporalConfig")<{
  readonly address: string;
  readonly namespace: string;
}> {}

/**
 * The connection, as a resource of the graph: di opens it with the scope and
 * closes it on every exit path, startup failure included.
 */
export class TemporalConnection extends Port("TemporalConnection")<NativeConnection> {}

/**
 * The service at `TemporalConfig.address` did not answer. Modeled rather than
 * left a defect because an operator *can* act on it — the address is wrong or
 * the service is down, and neither is a bug in this code — so `runMain` exits
 * `1`, a startup `Err`, not the `70` a defect earns.
 */
export class TemporalUnreachable extends TaggedError("TemporalUnreachable")<{
  readonly address: string;
  readonly cause: unknown;
}> {
  override message = `the Temporal service at ${this.address} did not answer`;
}

/** The runtime's port: what `temporal()` provides, and what the module `start` boots must export. */
export class TemporalRuntime extends RuntimePort<Runtime<never, TemporalInfo>> {}

/** The activity implementations `declareActivitiesHandler` takes for `C`, with no injected context. */
export type ActivitiesOf<C extends ContractDefinition> =
  DeclareActivitiesHandlerOptions<C>["activities"];

/**
 * `unknown` when the port's service is the implementations record for `C`,
 * `never` otherwise — intersected with `A` at the call site, so a port whose
 * service is not that record fails to typecheck there rather than at the first
 * activity attempt.
 */
type ActivitiesPort<A extends AnyPort, C extends ContractDefinition> =
  ServiceOf<A> extends ActivitiesOf<C> ? unknown : never;

export type TemporalOptions<C extends ContractDefinition, A extends AnyPort> = {
  /** The `temporal-contract` contract; the task queue this worker polls is read off it. */
  readonly contract: C;
  /**
   * The port the application provides its activity implementations on — the
   * record `declareActivitiesHandler` takes for `contract`, built by a provider
   * from the application's own services. The starter calls
   * `declareActivitiesHandler` itself, with its unit middleware in place.
   */
  readonly activities: A & ActivitiesPort<A, C>;
  readonly workflows: WorkflowSource;
  /** Pins `TemporalConfig.address` instead of reading `TEMPORAL_ADDRESS`. */
  readonly address?: string;
  /** Pins `TemporalConfig.namespace` instead of reading `TEMPORAL_NAMESPACE`. */
  readonly namespace?: string;
  /** Temporal's `shutdownForceTime`. Default `15 seconds`. Keep it at or below the kernel's `drainTimeoutMs`. */
  readonly forceAfter?: Duration;
  /** Temporal's `shutdownGraceTime`. Default `10 seconds`. */
  readonly gracePeriod?: Duration;
};

const DEFAULT_GRACE: Duration = "10 seconds";
const DEFAULT_FORCE: Duration = "15 seconds";

type Provided = TemporalRuntime | TemporalConfig | TemporalConnection;

/**
 * The Temporal starter: a module providing the runtime (`TemporalRuntime`),
 * its configuration (`TemporalConfig`, bound from `TEMPORAL_ADDRESS` /
 * `TEMPORAL_NAMESPACE` unless pinned here) and the connection
 * (`TemporalConnection`, a resource opened with the scope and closed with it;
 * a service that will not answer is a modeled `TemporalUnreachable`). Import
 * it next to the application, export `TemporalRuntime`, and provide the
 * `activities` port — that is the whole of the transport wiring. The
 * activities port is a **need** of this module, so a composition root that
 * forgets to provide it fails at `Module(...)`, di's own gate.
 *
 * With both configuration fields pinned the module reads nothing from the
 * environment (the declared `Env` need and `ConfigInvalid` stay — the kernel
 * discharges the one, a pinned config never produces the other); pin only one
 * and the other still comes from the environment.
 */
export const temporal = <C extends ContractDefinition, A extends AnyPort>(
  options: TemporalOptions<C, A>,
): Module<Provided, ConfigInvalid | TemporalUnreachable, Env | Scope | InstanceType<A>> => {
  const { address, namespace, activities } = options;
  const config =
    address !== undefined && namespace !== undefined
      ? Provider(TemporalConfig)({ value: { address, namespace } })
      : Config.provider(TemporalConfig)(
          Config.object({
            address: Config.pinned(
              address,
              Config.string("TEMPORAL_ADDRESS", { default: "127.0.0.1:7233" }),
            ),
            namespace: Config.pinned(
              namespace,
              Config.string("TEMPORAL_NAMESPACE", { default: "default" }),
            ),
          }),
        );
  return Module("Temporal")({
    provides: [
      config,
      Provider(TemporalConnection)([TemporalConfig], {
        acquire: (bound) =>
          fromPromise(
            NativeConnection.connect({ address: bound.address }),
            (cause) => new TemporalUnreachable({ address: bound.address, cause }),
          ),
        // On the drain-deadline path the kernel has already been handed its
        // thread back while `worker.run()` is still winding down on Temporal's
        // own clock, and `NativeConnection.close()` refuses while a Worker
        // holds it (`IllegalStateError`). That is not a teardown failure to
        // report — the worker releases the connection when its force-stop
        // lands, and the process is exiting — so only that refusal is
        // absorbed; any other close failure is still the finaliser's to
        // surface.
        release: (connection) =>
          connection
            .close()
            .catch((cause: unknown) => (heldByWorker(cause) ? undefined : Promise.reject(cause))),
      }),
      Provider(TemporalRuntime)([TemporalConnection, TemporalConfig, activities], {
        sync: (connection, bound, impls): Runtime<never, TemporalInfo> => ({
          name: "temporal",
          needs: [],
          start: (host) => createWorker(host, connection, bound, impls as ActivitiesOf<C>, options),
        }),
      }),
    ],
    exports: [TemporalRuntime, TemporalConfig, TemporalConnection],
  });
};

const startFailed = (cause: unknown): RuntimeStartFailed =>
  new RuntimeStartFailed({ runtime: "temporal", cause });

const heldByWorker = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "IllegalStateError";

const createWorker = <C extends ContractDefinition>(
  host: RuntimeHost<never>,
  connection: NativeConnection,
  config: ServiceOf<TemporalConfig>,
  activities: ActivitiesOf<C>,
  options: TemporalOptions<C, AnyPort>,
): AsyncResult<Serving<TemporalInfo>, RuntimeStartFailed> => {
  const { taskQueue } = options.contract;
  const { namespace } = config;

  // `declareActivitiesHandler` runs INSIDE the qualifier rather than before it.
  // It throws on a contract it cannot satisfy — an implementation the contract
  // does not declare, one it declares and finds missing — and calling it
  // outside would put that throw on the defect channel, where it is `runMain`'s
  // exit 70 instead of the 1 a modeled startup failure earns.
  return fromThrowable(
    () =>
      declareActivitiesHandler({
        contract: options.contract,
        middleware: activityUnits(host),
        activities,
      }),
    startFailed,
  )()
    .toAsync()
    .flatMap((handler) =>
      fromPromise(
        Worker.create({
          connection,
          namespace,
          taskQueue,
          ...options.workflows,
          activities: handler,
          shutdownGraceTime: options.gracePeriod ?? DEFAULT_GRACE,
          shutdownForceTime: options.forceAfter ?? DEFAULT_FORCE,
        }),
        startFailed,
      ),
    )
    .map((worker) => poll(worker, taskQueue, namespace));
};

const poll = (worker: Worker, taskQueue: string, namespace: string): Serving<TemporalInfo> => {
  // `run()` moves the worker to RUNNING synchronously, before its first await,
  // so the worker is already polling by the time this returns — which is what
  // lets `stopPolling` trust `getState()`.
  //
  // The result is HELD, not dropped: `run()` can defect, and an empty error
  // channel is not an empty defect channel. `drain` and `stop` hand it to the
  // kernel, which is what consumes it.
  const running = fromSafePromise(worker.run());

  // `shutdown()` on a worker that is not RUNNING throws Temporal's
  // `IllegalStateError`, and both methods below can reach it — on the signal
  // path `stop` always runs after `drain` already shut the worker down.
  const stopPolling = (): void => {
    if (worker.getState() === "RUNNING") worker.shutdown();
  };

  // The kernel's deadline, kept from `drain` so `stop` is released by the same
  // abort. Without it the release is only half done: `finish` calls `stop()`
  // after the drain has already timed out, and a `stop` that started waiting on
  // `running` all over again would put Temporal's `shutdownForceTime` back in
  // charge of when the process exits.
  let deadline: AbortSignal | undefined;

  const stopped = (): AsyncResult<void, never> =>
    deadline === undefined ? running : releasedBy(deadline, running);

  return {
    info: { taskQueue, namespace },
    // `@temporalio/worker` has no public forced-shutdown call —
    // `Worker.forceShutdown$` is `protected` and `Runtime.shutdown()` is
    // process-global — so the escalation available to a runtime is to stop
    // waiting: the kernel gets its thread back at its own deadline, and the
    // worker is left winding down on Temporal's `shutdownForceTime` clock
    // until the process exits.
    drain: (signal) => {
      deadline = signal;
      stopPolling();
      return stopped();
    },
    stop: () => {
      stopPolling();
      return stopped();
    },
  };
};

/**
 * `running`, but no later than the kernel's drain deadline.
 *
 * `Serving.drain(signal)` is a contract, not a courtesy: the kernel aborts
 * `signal` the instant its own timeout wins, precisely so a runtime that treats
 * it as its cue to return can be released. A worker whose activity never
 * finishes cannot honour that by waiting on `run()`, which settles on Temporal's
 * clock rather than the kernel's.
 *
 * The losing branch's `Result` is dropped, and it is the one drop in this
 * package: when the deadline wins, the kernel has already decided the report and
 * settled `exited`, so the worker's eventual outcome has no consumer left — and
 * an `AsyncResult` never rejects, so nothing floats. It is the same trade the
 * kernel's own `drainApp` documents for its race.
 */
const releasedBy = (
  signal: AbortSignal,
  running: AsyncResult<void, never>,
): AsyncResult<void, never> =>
  fromSafePromise(Promise.race([running, whenAborted(signal)])).flatMap((settled) => settled);

const whenAborted = (signal: AbortSignal): AsyncResult<void, never> =>
  signal.aborted
    ? OkAsync()
    : fromSafePromise(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
