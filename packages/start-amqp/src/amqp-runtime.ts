import { TypedAmqpWorker } from "@amqp-contract/worker";
import type { AnyPort } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/start";
import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";

/** What the worker publishes once it is consuming, read back through `RunningApp.runtimeInfo()`. */
export type AmqpInfo = { readonly queues: readonly string[] };

export type AmqpOptions<Needs extends AnyPort> = {
  readonly urls: readonly string[];
  readonly contract: Parameters<typeof TypedAmqpWorker.create>[0]["contract"];
  /**
   * Handlers as the worker will see them — already final. Built through
   * `amqp-contract`'s `declareHandler`/`declareHandlers`, with this package's
   * `messageUnits` in the middleware slot. A builder rather than a finished
   * record because the middleware needs the `RuntimeHost`, which does not
   * exist until `start` calls this runtime.
   */
  readonly handlers: (host: RuntimeHost<Needs>) => Record<string, unknown>;
  readonly middleware?: (host: RuntimeHost<Needs>) => unknown;
  readonly needs: readonly Needs[];
  readonly connectionOptions?: Record<string, unknown>;
  readonly defaultConsumerOptions?: Record<string, unknown>;
  /**
   * How long `create` waits for the connection before failing. Passed straight
   * through — it is a top-level `CreateWorkerOptions` field, NOT nested under
   * `connectionOptions`, where setting it is silently inert. Without it an
   * unreachable broker takes the library's 30s default to report.
   */
  readonly connectTimeoutMs?: number;
};

export const amqpRuntime = <Needs extends AnyPort>(
  options: AmqpOptions<Needs>,
): Runtime<Needs, AmqpInfo> => ({
  name: "amqp",
  needs: options.needs,
  start: (host: RuntimeHost<Needs>) => createWorker(host, options),
});

/**
 * Every queue the contract's consumers and RPCs drain, sorted and
 * de-duplicated. Derived rather than configured, so `Serving.info` cannot
 * disagree with what the worker actually consumes.
 */
const queuesOf = (contract: AmqpOptions<AnyPort>["contract"]): readonly string[] =>
  [
    ...new Set(
      Object.values({ ...contract.consumers, ...contract.rpcs }).map((entry) => entry.queue.name),
    ),
  ].sort();

const createWorker = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  options: AmqpOptions<Needs>,
): AsyncResult<Serving<AmqpInfo>, RuntimeStartFailed> =>
  TypedAmqpWorker.create({
    contract: options.contract,
    handlers: options.handlers(host),
    ...(options.middleware === undefined
      ? {}
      : {
          // `AmqpOptions.middleware` returns `unknown`, deliberately: this
          // task's public surface never imports `@amqp-contract/worker`'s
          // `WorkerMiddleware` type (same reasoning as `contract` above, and
          // Task 3's `messageUnits` is the one caller that actually produces
          // one). The cast is confined to this boundary.
          middleware: options.middleware(host) as NonNullable<
            Parameters<typeof TypedAmqpWorker.create>[0]["middleware"]
          >,
        }),
    urls: [...options.urls],
    ...(options.connectionOptions === undefined
      ? {}
      : { connectionOptions: options.connectionOptions }),
    ...(options.defaultConsumerOptions === undefined
      ? {}
      : { defaultConsumerOptions: options.defaultConsumerOptions }),
    ...(options.connectTimeoutMs === undefined
      ? {}
      : { connectTimeoutMs: options.connectTimeoutMs }),
  })
    .map((worker) => consume(worker, queuesOf(options.contract)))
    // `create` reports a connection failure on the DEFECT channel with a
    // `TechnicalError` cause — never a modeled `Err`. This is the one place
    // where that is a *startup* failure rather than an unmodelled one, and
    // moving it back is what keeps `runMain`'s exit code 1 rather than 70.
    .recoverDefect((cause) => ErrAsync(new RuntimeStartFailed({ runtime: "amqp", cause })));

const consume = (worker: TypedAmqpWorker<never>, queues: readonly string[]): Serving<AmqpInfo> => {
  // `close()` is the whole of this worker's shutdown — cancel every consumer,
  // drain in-flight handlers so their acks land on a still-open channel, then
  // close. Memoised because both methods reach it and the kernel calls `stop`
  // after `drain` on the signal path.
  //
  // The result is HELD, not dropped: `close()` can defect, and an empty error
  // channel is not an empty defect channel.
  let closing: AsyncResult<void, never> | undefined;
  const beginClose = (): AsyncResult<void, never> =>
    (closing ??= worker.close({ drainTimeoutMs: null }));

  // The kernel's deadline, kept from `drain` so `stop` is released by the same
  // abort. `drainTimeoutMs: null` is deliberate: the library's own
  // DEFAULT_DRAIN_TIMEOUT_MS is 30s and would sit ABOVE the kernel's 20s
  // default, quietly winning. One deadline in the process, and it is the
  // kernel's.
  let deadline: AbortSignal | undefined;
  const stopped = (): AsyncResult<void, never> =>
    deadline === undefined ? beginClose() : releasedBy(deadline, beginClose());

  return {
    info: { queues },
    drain: (signal) => {
      deadline = signal;
      return stopped();
    },
    stop: () => stopped(),
  };
};

/**
 * `closing`, but no later than the kernel's drain deadline.
 *
 * `Serving.drain(signal)` is a contract, not a courtesy: the kernel aborts
 * `signal` the instant its own timeout wins, precisely so a runtime that treats
 * it as its cue to return can be released. A delivery whose handler never
 * finishes cannot honour that by waiting on `close()`, which settles on the
 * library's own drain clock rather than the kernel's.
 *
 * The losing branch's `Result` is dropped, and it is the one drop in this
 * package: when the deadline wins, the kernel has already decided the report
 * and settled `exited`, so the worker's eventual close has no consumer left —
 * and an `AsyncResult` never rejects, so nothing floats. Losing here is
 * cheaper than it is for `-temporal` or `-http`: the un-acked deliveries are
 * redelivered by the broker, so abandonment loses nothing and repeats
 * something — where an abandoned HTTP response is an answer nobody gets and an
 * abandoned Temporal activity is a platform retry. It is the same trade the
 * kernel's own `drainApp` documents for its race.
 */
const releasedBy = (
  signal: AbortSignal,
  closing: AsyncResult<void, never>,
): AsyncResult<void, never> =>
  fromSafePromise(Promise.race([closing, whenAborted(signal)])).flatMap((settled) => settled);

const whenAborted = (signal: AbortSignal): AsyncResult<void, never> =>
  signal.aborted
    ? OkAsync()
    : fromSafePromise(
        new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      );
