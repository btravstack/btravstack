import type { AnyPort } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/start-core";
import type { Duration } from "@temporalio/common";
import {
  Worker,
  type NativeConnection,
  type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { OkAsync, fromPromise, fromSafePromise, fromThrowable, type AsyncResult } from "unthrown";

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

export type TemporalOptions<Needs extends AnyPort> = {
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly namespace?: string;
  readonly workflows: WorkflowSource;
  /**
   * Activities as Temporal will see them — already final. Built through
   * `temporal-contract`'s `declareActivitiesHandler` with this package's
   * `activityUnits` in the middleware slot. The factory never wraps, which is
   * what makes double-wrapping impossible rather than something to detect.
   *
   * A builder rather than an already-built record because `activityUnits`
   * needs the `RuntimeHost` to open units against, and the host does not
   * exist until `start` calls this runtime.
   */
  readonly activities: (host: RuntimeHost<Needs>) => Record<string, (...args: never[]) => unknown>;
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

const startFailed = (cause: unknown): RuntimeStartFailed =>
  new RuntimeStartFailed({ runtime: "temporal", cause });

const createWorker = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  options: TemporalOptions<Needs>,
): AsyncResult<Serving<TemporalInfo>, RuntimeStartFailed> => {
  const namespace = options.namespace ?? DEFAULT_NAMESPACE;

  // The builder runs INSIDE the qualifier rather than before it.
  // `declareActivitiesHandler` throws on a contract it cannot satisfy — two
  // implementations for one activity name, an implementation the contract does
  // not declare — and calling it outside would put that throw on the defect
  // channel, where it is `runMain`'s exit 70 instead of the 1 a modeled startup
  // failure earns.
  return fromThrowable(
    options.activities,
    startFailed,
  )(host)
    .toAsync()
    .flatMap((activities) =>
      fromPromise(
        Worker.create({
          connection: options.connection,
          namespace,
          taskQueue: options.taskQueue,
          ...options.workflows,
          activities,
          shutdownGraceTime: options.gracePeriod ?? DEFAULT_GRACE,
          shutdownForceTime: options.forceAfter ?? DEFAULT_FORCE,
        }),
        startFailed,
      ),
    )
    .map((worker) => poll(worker, options.taskQueue, namespace));
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
