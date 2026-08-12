import type { AnyPort } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/start";
import type { Duration } from "@temporalio/common";
import {
  Worker,
  type NativeConnection,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { OkAsync, fromPromise, fromSafePromise, type AsyncResult } from "unthrown";

/** What the worker publishes once it is polling, read back through `RunningApp.runtimeInfo()`. */
export type TemporalInfo = {
  readonly taskQueue: string;
  readonly namespace: string;
};

export type TemporalOptions<Needs extends AnyPort> = {
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly namespace?: string;
  readonly workflows:
    | { readonly workflowsPath: string }
    | { readonly workflowBundle: WorkflowBundleWithSourceMap };
  /**
   * Activities as Temporal will see them — already final. Wrap plain
   * implementations with `asActivities`, or use the `activityUnits` middleware
   * with `temporal-contract`. The factory never wraps, which is what makes
   * double-wrapping impossible rather than something to detect.
   */
  readonly activities: Record<string, (...args: never[]) => unknown>;
  readonly needs: readonly Needs[];
  /** Temporal's `shutdownForceTime`. Default `15 seconds`. Keep it at or below the kernel's `drainTimeoutMs`. */
  readonly forceAfter?: Duration;
  /** Temporal's `shutdownGraceTime`. Default `10 seconds`. */
  readonly gracePeriod?: Duration;
};

const DEFAULT_NAMESPACE = "default";
const DEFAULT_GRACE: Duration = "10 seconds";
const DEFAULT_FORCE: Duration = "15 seconds";

export const temporalRuntime = <Needs extends AnyPort>(
  options: TemporalOptions<Needs>,
): Runtime<Needs, TemporalInfo> => ({
  name: "temporal",
  needs: options.needs,
  start: (host: RuntimeHost<Needs>) => createWorker(host, options),
});

const createWorker = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  options: TemporalOptions<Needs>,
): AsyncResult<Serving<TemporalInfo>, RuntimeStartFailed> => {
  void host;
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  return fromPromise(
    Worker.create({
      connection: options.connection,
      namespace,
      taskQueue: options.taskQueue,
      ...options.workflows,
      activities: options.activities,
      shutdownGraceTime: options.gracePeriod ?? DEFAULT_GRACE,
      shutdownForceTime: options.forceAfter ?? DEFAULT_FORCE,
    }),
    (cause) => new RuntimeStartFailed({ runtime: "temporal", cause }),
  ).map((worker) => poll(worker, options.taskQueue, namespace));
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

  return {
    info: { taskQueue, namespace },
    drain: (signal) => {
      void signal;
      stopPolling();
      return OkAsync();
    },
    stop: () => {
      stopPolling();
      return running;
    },
  };
};
