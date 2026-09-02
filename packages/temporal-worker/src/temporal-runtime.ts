import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import {
  Observers,
  RuntimePort,
  RuntimeStartFailed,
  noObserver,
  releasedBy,
  type Operation,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type Settle,
} from "@btravstack/core";
import {
  Module,
  Port,
  Provider,
  type PortClassOf,
  type PortInstance,
  type Scope,
  type ServiceOf,
} from "@btravstack/di";
import type { ContractDefinition } from "@temporal-contract/contract";
import {
  declareActivitiesHandler,
  type DeclareActivitiesHandlerOptions,
} from "@temporal-contract/worker/activity";
import { msToNumber, type Duration } from "@temporalio/common";
import { NativeConnection, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import {
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
  /** Temporal's `shutdownGraceTime`, in milliseconds. */
  readonly gracePeriodMs: number;
  /** Temporal's `shutdownForceTime`, in milliseconds. */
  readonly forceAfterMs: number;
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
 * The activities' port — one id, the starter's own, which an application never
 * names. Generic at the value level (one `Port(...)` call, so no duplicate-id
 * warning however many contracts instantiate it) and fixed per contract at the
 * type level through `ActivitiesPortOf<C>`, so a provider built for one contract
 * cannot be handed to a module declaring another. Exported for this package's
 * tests, not from `index.ts`.
 */
export const TemporalActivitiesPort = Port("TemporalActivities");

/** The activities port class, typed for `C`: what `TemporalActivities(contract)(…).port` is. */
export type ActivitiesPortOf<C extends ContractDefinition> = PortClassOf<
  "TemporalActivities",
  ActivitiesOf<C>
>;

/** The activities port's instance for `C` — the module's one need. */
export type ActivitiesInstanceOf<C extends ContractDefinition> = PortInstance<
  "TemporalActivities",
  ActivitiesOf<C>
>;

/**
 * What a Temporal deployment tunes, shared verbatim by `temporal()` and
 * `TemporalModule` — spelled once so the two cannot drift, which is what a
 * second copy of an option list always eventually does.
 */
export type TemporalTuning = {
  /** Pins `TemporalConfig.address` instead of reading `TEMPORAL_ADDRESS`. */
  readonly address?: string;
  /** Pins `TemporalConfig.namespace` instead of reading `TEMPORAL_NAMESPACE`. */
  readonly namespace?: string;
  /**
   * Pins `TemporalConfig.forceAfterMs` instead of reading
   * `TEMPORAL_FORCE_AFTER_MS` (default `15_000`) — Temporal's
   * `shutdownForceTime`. Keep it at or below the kernel's `drainTimeoutMs`,
   * which is why it reads the environment: the two are set together, in the
   * same manifest.
   */
  readonly forceAfter?: Duration;
  /**
   * Pins `TemporalConfig.gracePeriodMs` instead of reading
   * `TEMPORAL_GRACE_PERIOD_MS` (default `10_000`) — Temporal's
   * `shutdownGraceTime`.
   */
  readonly gracePeriod?: Duration;
};

export type TemporalOptions<C extends ContractDefinition> = TemporalTuning & {
  /**
   * The contract; the task queue this worker polls is read off it, and the
   * activities port is typed by it. The starter calls
   * `declareActivitiesHandler` itself, with its unit middleware in place.
   */
  readonly contract: C;
  readonly workflows: WorkflowSource;
};

const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_FORCE_MS = 15_000;

/**
 * A `Duration` as the milliseconds a config field holds. Temporal's own
 * `msToNumber` is what parses its string form, and it is exported for exactly
 * this — a pin of `"10 seconds"` and a `TEMPORAL_GRACE_PERIOD_MS` of `10000`
 * have to reach the worker as the same number.
 */
const durationMs = (duration: Duration | undefined): number | undefined =>
  duration === undefined ? undefined : msToNumber(duration);

type Provided = TemporalRuntime | TemporalConfig | TemporalConnection;

/**
 * The Temporal starter: a module providing the runtime, its configuration
 * (bound from `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE` unless pinned) and the
 * connection (a resource opened with the scope and closed with it; a service
 * that will not answer is a modeled `TemporalUnreachable`). Import it next to
 * the application, export `TemporalRuntime`, provide the activities — the
 * activities port is a need of this module.
 *
 * With both configuration fields pinned the module reads nothing from the
 * environment; pin only one and the other still comes from it.
 */
export const temporal = <C extends ContractDefinition>(
  options: TemporalOptions<C>,
): Module<Provided, ConfigInvalid | TemporalUnreachable, Env | Scope | ActivitiesInstanceOf<C>> => {
  const { address, namespace } = options;
  const activities = TemporalActivitiesPort as ActivitiesPortOf<C>;
  const config = Config.provider(TemporalConfig)(
    Config.object({
      address: Config.pinned(
        address,
        Config.string("TEMPORAL_ADDRESS", { default: "127.0.0.1:7233" }),
      ),
      namespace: Config.pinned(
        namespace,
        Config.string("TEMPORAL_NAMESPACE", { default: "default" }),
      ),
      gracePeriodMs: Config.pinned(
        durationMs(options.gracePeriod),
        Config.integer("TEMPORAL_GRACE_PERIOD_MS", { default: DEFAULT_GRACE_MS, min: 0 }),
      ),
      forceAfterMs: Config.pinned(
        durationMs(options.forceAfter),
        Config.integer("TEMPORAL_FORCE_AFTER_MS", { default: DEFAULT_FORCE_MS, min: 0 }),
      ),
    }),
  );
  return Module("Temporal")({
    needs: [Env, activities],
    provides: [
      config,
      Provider(TemporalConnection)({
        inject: { config: TemporalConfig },
        acquire: ({ config: bound }) =>
          fromPromise(
            NativeConnection.connect({ address: bound.address }),
            (cause) => new TemporalUnreachable({ address: bound.address, cause }),
          ),
        // `close()` refuses with `IllegalStateError` while a Worker still
        // holds the connection, which is the ordinary state on the
        // drain-deadline path and not a teardown failure to report. Only that
        // refusal is absorbed; any other close failure still surfaces.
        release: (connection) =>
          connection
            .close()
            .catch((cause: unknown) => (heldByWorker(cause) ? undefined : Promise.reject(cause))),
      }),
      // The no-op member, so the set this module reads is never the empty
      // dependency di refuses: a graph composing no observability still starts.
      Provider.member(Observers)({ inject: {}, value: noObserver }),
      Provider(TemporalRuntime)({
        inject: {
          connection: TemporalConnection,
          config: TemporalConfig,
          activities,
          observers: Observers,
        },
        sync: ({
          connection,
          config: bound,
          activities: impls,
          observers,
        }): Runtime<never, TemporalInfo> => ({
          name: "temporal",
          resolves: [],
          start: (host) => createWorker(host, connection, bound, impls, options, observers),
        }),
      }),
    ],
    exports: [TemporalRuntime, TemporalConfig, TemporalConnection],
  } as never) as unknown as Module<
    Provided,
    ConfigInvalid | TemporalUnreachable,
    Env | Scope | ActivitiesInstanceOf<C>
  >;
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
  options: TemporalOptions<C>,
  observers: readonly ((operation: Operation) => Settle)[],
): AsyncResult<Serving<TemporalInfo>, RuntimeStartFailed> => {
  const { taskQueue } = options.contract;
  const { namespace } = config;

  // INSIDE the qualifier: `declareActivitiesHandler` throws on a contract it
  // cannot satisfy, and outside it that throw is a defect — `runMain` exit 70
  // where a modeled startup failure earns 1.
  return fromThrowable(
    () =>
      declareActivitiesHandler({
        contract: options.contract,
        middleware: activityUnits(host, observers),
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
          shutdownGraceTime: config.gracePeriodMs,
          shutdownForceTime: config.forceAfterMs,
        }),
        startFailed,
      ),
    )
    .map((worker) => poll(worker, taskQueue, namespace));
};

const poll = (worker: Worker, taskQueue: string, namespace: string): Serving<TemporalInfo> => {
  // `run()` moves the worker to RUNNING synchronously, before its first await,
  // which is what lets `stopPolling` trust `getState()`. The result is HELD,
  // not dropped: `run()` can defect, and an empty error channel is not an empty
  // defect channel.
  const running = fromSafePromise(worker.run());

  // `shutdown()` on a worker that is not RUNNING throws Temporal's
  // `IllegalStateError`, and both methods below can reach it — on the signal
  // path `stop` always runs after `drain` already shut the worker down.
  const stopPolling = (): void => {
    if (worker.getState() === "RUNNING") worker.shutdown();
  };

  // The kernel's deadline, kept from `drain` so `stop` is released by the same
  // abort. Without it a `stop` that waits on `running` all over again puts
  // Temporal's `shutdownForceTime` back in charge of when the process exits.
  let deadline: AbortSignal | undefined;

  const stopped = (): AsyncResult<void, never> =>
    deadline === undefined ? running : releasedBy(deadline, running);

  return {
    info: { taskQueue, namespace },
    // `@temporalio/worker` exposes no public forced shutdown, so the only
    // escalation is to stop waiting: the kernel gets its thread back at its own
    // deadline and the worker winds down on Temporal's clock.
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
