import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/start";
import { Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import type { OrderContract } from "@btravstack/start-example-order-temporal-contract";
import {
  declareActivitiesHandler,
  type ActivityImplementationFor,
} from "@temporal-contract/worker/activity";
import { TypedWorker } from "@temporal-contract/worker/worker";
import { activityInfo } from "@temporalio/activity";
import type { Duration } from "@temporalio/common";
import type { NativeConnection, WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { ErrAsync, OkAsync, P, fromSafePromise, type AsyncResult } from "unthrown";

/**
 * What the worker publishes about itself once it is polling, read back through
 * `RunningApp.runtimeInfo()`.
 *
 * A Temporal worker's identity **is** its task queue and namespace — the pair
 * an operator needs to find it in the Web UI, and the pair that decides which
 * work it will ever be handed. The API publishes `{ port, prefix }` and the
 * queue worker `{ queue, concurrency }` on the same channel; no two of the
 * three shapes share a field, which is why `Info` is the runtime's own type
 * parameter rather than anything the kernel models.
 */
export type OrderTemporalInfo = { readonly taskQueue: string; readonly namespace: string };

/**
 * Where the workflow sandbox's code comes from. Two arms because the two
 * callers genuinely differ: a process points at the module and lets Temporal
 * bundle it, while a spec hands over a bundle `bundleFor` already built and
 * memoised — bundling per test is the single most expensive thing in this suite.
 */
export type WorkflowSource =
  | { readonly workflowsPath: string }
  | { readonly workflowBundle: WorkflowBundleWithSourceMap };

export type OrderTemporalOptions = {
  /**
   * The contract, and with it the task queue this worker polls —
   * `TypedWorker.create` reads `taskQueue` off it rather than taking one.
   */
  readonly contract: OrderContract;
  /**
   * An open connection to the Temporal service. Handed in rather than opened
   * here, exactly as the queue runtime is handed its broker: `main.ts` builds
   * one from the environment, and a spec passes the test environment's.
   */
  readonly connection: NativeConnection;
  readonly namespace?: string;
  readonly workflows: WorkflowSource;
  /**
   * How long an activity that is *cancellation-aware* gets to notice the
   * shutdown. Set explicitly because Temporal's default is `0`, and cancelling
   * the instant `drain` is called would fight the kernel's own drain deadline
   * for the same decision. Default `10 seconds`.
   */
  readonly gracePeriod?: Duration;
  /**
   * The hard stop. After it, `run()` settles with a
   * `GracefulShutdownPeriodExpiredError` and in-flight work is abandoned where
   * it stands.
   *
   * It is Temporal's **own** clock, not the kernel's, and the two are not the
   * same deadline: the kernel releases this runtime the moment its
   * `drainTimeoutMs` passes (see `poll` below), whatever the worker is still
   * doing. Set this at or below `drainTimeoutMs` if you want the worker to have
   * finished forcing itself down by the time the kernel gives up on it.
   * Default `30 seconds`.
   */
  readonly forceAfter?: Duration;
};

/**
 * The ports this runtime resolves out of the application context — the same two
 * the queue worker needs, and for the same reason: `FindOrder` is not part of
 * any activity this worker registers, and a runtime declares what *it* needs
 * rather than what the module happens to export.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something
 * (`src/needs-gate.test-d.ts` pins both directions).
 */
type TemporalNeeds = typeof PlaceOrder | typeof Logger;

/**
 * A `Runtime` serving the order application as a Temporal worker.
 *
 * - `start` builds the worker (bundling the workflow module, connecting the
 *   poller) and begins the worker loop. A bundle that will not compile or a
 *   service that will not answer is a modeled `Err(RuntimeStartFailed)`, never
 *   a throw — `TypedWorker.create` reports both as a defect carrying a
 *   `TechnicalError`, and this is the one place where that is a *startup*
 *   failure rather than an unmodelled one.
 * - `Serving.drain` calls `worker.shutdown()`, which moves the worker to
 *   `DRAINING` immediately: polling for new Workflow and Activity Tasks stops
 *   at once, in-flight activities run to completion, and `run()` resolves when
 *   the last of them has. So the drain is a genuine wait, not a courtesy — and
 *   it is bounded by the kernel's deadline signal rather than only by the
 *   worker's own `forceAfter`.
 * - `Serving.stop` is the same call made idempotent. Once the worker has
 *   drained, `running` has already settled and awaiting it again returns at
 *   once; when `stop()` is the *only* call — the path a `stop()` that skipped
 *   the drain takes — it is what shuts the worker down, with `forceAfter` as
 *   the ceiling.
 */
export const temporalWorkerRuntime = (
  options: OrderTemporalOptions,
): Runtime<TemporalNeeds, OrderTemporalInfo> => ({
  name: "temporal-worker",
  needs: [PlaceOrder, Logger],
  start: (host) => createWorker(host, options),
});

const createWorker = (
  host: RuntimeHost<TemporalNeeds>,
  options: OrderTemporalOptions,
): AsyncResult<Serving<OrderTemporalInfo>, RuntimeStartFailed> => {
  const namespace = options.namespace ?? "default";

  return TypedWorker.create({
    contract: options.contract,
    connection: options.connection,
    namespace,
    ...options.workflows,
    activities: declareActivitiesHandler({
      contract: options.contract,
      activities: { placeOrder: { place: placeActivity(host) } },
    }),
    shutdownGraceTime: options.gracePeriod ?? "10 seconds",
    shutdownForceTime: options.forceAfter ?? "30 seconds",
  })
    .map((worker) => poll(worker, options.contract.taskQueue, namespace))
    .recoverDefect((cause) =>
      ErrAsync(new RuntimeStartFailed({ runtime: "temporal-worker", cause })),
    );
};

const poll = (
  worker: TypedWorker,
  taskQueue: string,
  namespace: string,
): Serving<OrderTemporalInfo> => {
  // `Worker.run()` moves the state to RUNNING synchronously, before its first
  // await, so the worker is already polling by the time this returns — which is
  // what lets `stopPolling` below trust `getState()`.
  //
  // The result is HELD, not dropped: `run()` is `AsyncResult<void, never>`, and
  // an empty error channel is not an empty defect channel. Both `drain` and
  // `stop` hand it to the kernel, which is what consumes it.
  const running = worker.run();

  // `shutdown()` on a worker that is not RUNNING throws Temporal's
  // `IllegalStateError`, and both methods below can reach it — on the signal
  // path `stop` always runs after `drain` has already shut the worker down.
  const stopPolling = (): void => {
    if (worker.raw.getState() === "RUNNING") worker.shutdown();
  };

  // The kernel's deadline, kept from `drain` so `stop` is released by the same
  // abort. Without it the release would only be half done: `finish` calls
  // `stop()` after the drain has already timed out, and a `stop` that started
  // waiting on `running` all over again would put the worker's own
  // `forceAfter` back in charge of when the process exits.
  let deadline: AbortSignal | undefined;

  const stopped = (): AsyncResult<void, never> =>
    deadline === undefined ? running : releasedBy(deadline, running);

  return {
    info: { taskQueue, namespace },
    // `@temporalio/worker` 1.22 has no public forced-shutdown call —
    // `Worker.forceShutdown$` is `protected` and `Runtime.shutdown()` is
    // process-global — so the escalation available to a runtime is to stop
    // waiting: the kernel is handed back its thread at its own deadline, and
    // the worker is left to Temporal's `forceAfter` clock and to the entry
    // point closing the connection underneath it.
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
 * `Serving.drain(signal)` is a contract, not a courtesy: the kernel races its
 * timeout against the runtime having stopped and aborts `signal` the instant
 * that race settles, precisely so a runtime that treats it as its cue to return
 * can be released. A worker whose activity never finishes cannot honour it by
 * waiting on `run()` — that resolves on Temporal's clock, not the kernel's.
 *
 * The losing branch's `Result` is dropped, and it is the one drop here: when
 * the deadline wins, the kernel has already decided the report and settled
 * `exited`, so the worker's eventual outcome has no consumer left — and an
 * `AsyncResult` never rejects, so nothing floats. That is the same trade
 * `drainApp` documents for its own race.
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

/**
 * The one activity, and the hinge of this whole example.
 *
 * It is built as a **factory over the `RuntimeHost`** rather than declared at
 * module scope, because a Temporal activity is where the process leaves the
 * workflow sandbox and reaches real services — so it is the natural place to
 * open a kernel unit, and closing over `host` is how the di context gets there
 * without a module-level global.
 *
 * The `mapErrCases` is the triage point, and the third sibling of
 * `order-api`'s into `ORPCError` codes and `order-worker`'s into
 * ack/dead-letter. The same `Err` lands somewhere else again: `DuplicateOrder`
 * is a `CONFLICT` over HTTP because a caller is waiting to be told, and a
 * dead-letter on a queue because none is. Here there *is* a caller — a
 * workflow, and behind it a client — so it becomes a typed contract error the
 * client branches on by name. What is new is the second thing this mapping
 * decides: `contract.ts` declares both of these `nonRetryable`, so naming a
 * failure here is also what tells **Temporal** to stop retrying it. An
 * unmodelled failure stays unnamed and the retry policy takes over — the
 * platform doing for free what the queue worker hand-rolls with an attempt
 * budget.
 *
 * Every case is named. A new domain error is a compile error here, at the one
 * place that has to decide what the workflow sees.
 */
const placeActivity =
  (
    host: RuntimeHost<TemporalNeeds>,
  ): ActivityImplementationFor<OrderContract, "placeOrder", "place"> =>
  (args, { errors }) =>
    host.run(metaFor(), (ctx, _signal) =>
      ctx
        .get(PlaceOrder)
        .execute(args.orderId, args.quantity)
        .map((order) => ({ id: order.id, quantity: order.quantity }))
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) => errors.InvalidQuantity({ id: error.id }))
            .with(P.tag("DuplicateOrder"), (error) => errors.OrderAlreadyPlaced({ id: error.id })),
        ),
    );

/**
 * `UnitMeta.id` must be unique per unit, and a **workflow id is not one** —
 * which is worth stating because it is the obvious choice here and it is wrong
 * twice over: an activity is retried under the same execution, and Temporal
 * lets a workflow id be reused once an execution has closed. The queue worker
 * answers the same problem by making the *delivery* the id rather than the
 * message; here the platform already mints exactly that value. A **task token**
 * identifies one activity task attempt, so its uniqueness is Temporal's
 * guarantee rather than an argument of ours.
 *
 * The workflow id becomes the `traceId`, which is what `traceId` is for. It is
 * the correlation id, minted outside this process by whoever started the
 * execution, and it holds steady across every retry, so all three attempts join
 * up in the log. An activity not started by a workflow has none — a case this
 * contract never produces, but the SDK types it as possible — and falls back to
 * the activity id, which is likewise stable across that activity's attempts.
 *
 * `activityInfo()` is Temporal's own ambient read, available here because this
 * runs inside the activity's execution context — before the kernel opens its
 * own.
 */
const metaFor = (): UnitMeta => {
  const info = activityInfo();
  return {
    kind: "activity",
    id: info.base64TaskToken,
    traceId: info.workflowExecution?.workflowId ?? info.activityId,
  };
};
