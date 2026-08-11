import type { Context, ServiceOf } from "@btravstack/di";
import type { Runtime, RuntimeHost, Serving, UnitMeta } from "@btravstack/start";
import { Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { OkAsync, P, fromSafePromise, type AsyncResult } from "unthrown";

import type { Delivery, OrderQueue, PlaceOrderJob } from "./queue.js";

/**
 * What the worker publishes about itself once it is consuming, read back
 * through `RunningApp.runtimeInfo()`.
 *
 * Nothing like the API's `{ port, prefix }`, which is the point: `Serving.info`
 * is the runtime's own shape and deliberately not modelled as a port number. A
 * queue consumer has no port, and what an operator wants to know about one is
 * which queue it is on and how many messages it will take at a time.
 */
export type OrderWorkerInfo = { readonly queue: string; readonly concurrency: number };

export type QueueWorkerOptions = {
  readonly queue: OrderQueue;
  /** How many deliveries may be in flight at once. Default `1`. */
  readonly concurrency?: number;
  /** How many times a message may be delivered before it is parked. Default `3`. */
  readonly maxAttempts?: number;
};

/**
 * The ports this runtime resolves out of the application context — two of the
 * three the module exports, because `FindOrder` is not part of any job this
 * worker consumes. A runtime declares what *it* needs, not what the module has.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something.
 * A module that does not export both fails to compile at the `start(...)` call,
 * before anything runs (`src/needs-gate.test-d.ts` pins both directions).
 */
type WorkerNeeds = typeof PlaceOrder | typeof Logger;

/**
 * A `Runtime` consuming order jobs off a queue.
 *
 * - `start` subscribes to the queue and begins pumping. There is nothing to
 *   bind, so the error channel is empty here — a worker holding a real broker
 *   connection would report a failed connect as `Err(RuntimeStartFailed)`,
 *   exactly as the oRPC runtime reports a failed bind.
 * - `Serving.drain` stops *claiming*. Deliveries already in flight are the
 *   kernel's to time out, and the kernel's deadline signal has nothing to
 *   cancel here. A message not yet claimed stays in the queue **unsettled**,
 *   and the drain does not wait for it: draining hands nothing back to a
 *   broker, it stops taking more, and the next worker on the queue takes it.
 *   So a producer awaiting that message's settlement — the convenience
 *   `OrderQueue.publish` offers — waits forever.
 * - `Serving.stop` is the same act with nothing left to add: an in-memory queue
 *   has no connection to close.
 */
export const queueWorkerRuntime = (
  options: QueueWorkerOptions,
): Runtime<WorkerNeeds, OrderWorkerInfo> => ({
  name: "queue-worker",
  needs: [PlaceOrder, Logger],
  start: (host) => OkAsync(consume(host, options)),
});

/**
 * How a delivery ends. This is the transport mapping, and the whole reason this
 * package exists beside `order-api`: the same three channels, folded into a
 * queue's vocabulary instead of HTTP's.
 */
type Disposition =
  | { readonly kind: "ack" }
  | { readonly kind: "dead-letter"; readonly reason: string }
  | { readonly kind: "retry"; readonly reason: string };

const ack: Disposition = { kind: "ack" };
const deadLetter = (reason: string): Disposition => ({ kind: "dead-letter", reason });
const retry = (reason: string): Disposition => ({ kind: "retry", reason });

/**
 * The triage point — the boundary where the application's vocabulary stops,
 * and the mirror of `order-api`'s `mapErrCases` into `ORPCError` codes.
 *
 * The same `Err` lands somewhere else entirely. `DuplicateOrder` is a `CONFLICT`
 * over HTTP because there is a caller waiting to be told; a queue has no caller,
 * so the message is **parked** for a human instead. `InvalidQuantity` likewise:
 * a redelivery would ask the same impossible thing again. What *is* worth
 * another delivery is a `Defect` — an unmodelled failure is the infrastructure
 * one, and infrastructure comes back.
 *
 * Every case is named. A new domain error is a compile error here, at the one
 * place that has to decide what happens to the message.
 */
const dispositionOf = (
  ctx: Context<InstanceType<WorkerNeeds>>,
  job: PlaceOrderJob,
): AsyncResult<Disposition, never> =>
  fromSafePromise(
    ctx
      .get(PlaceOrder)
      .execute(job.orderId, job.quantity)
      .match({
        ok: () => ack,
        errCases: (matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) => deadLetter(error._tag))
            .with(P.tag("DuplicateOrder"), (error) => deadLetter(error._tag)),
        defect: (cause) => retry(String(cause)),
      }),
  );

/**
 * Applying the disposition, **inside the unit**.
 *
 * This is the queue-shaped form of the contract a runtime owes: a unit closes
 * the instant its `Result` settles, and an idle registry is the kernel's
 * permission to call `Serving.stop()`. Settling the message after the unit
 * returned would race that — the message would be neither acked nor requeued
 * when the process went away. Flushing a response and acking a message are the
 * same obligation.
 */
const dispose = (
  logger: ServiceOf<Logger>,
  queue: OrderQueue,
  delivery: Delivery,
  maxAttempts: number,
  disposition: Disposition,
): AsyncResult<void, never> => {
  const { job, attempt } = delivery;

  if (disposition.kind === "retry" && attempt < maxAttempts) {
    logger.info(`job ${job.id} retried after attempt ${attempt}: ${disposition.reason}`);
    queue.requeue(delivery);
    return OkAsync();
  }

  logger.info(`job ${job.id} ${disposition.kind === "ack" ? "acked" : "dead-lettered"}`);
  queue.settle(
    disposition.kind === "ack"
      ? { jobId: job.id, outcome: "acked", attempts: attempt }
      : { jobId: job.id, outcome: "dead-lettered", reason: disposition.reason, attempts: attempt },
  );
  return OkAsync();
};

const deliver = (
  host: RuntimeHost<WorkerNeeds>,
  queue: OrderQueue,
  delivery: Delivery,
  maxAttempts: number,
): AsyncResult<void, never> =>
  host.run(metaFor(delivery), (ctx, _signal) =>
    dispositionOf(ctx, delivery.job).flatMap((disposition) =>
      dispose(ctx.get(Logger), queue, delivery, maxAttempts, disposition),
    ),
  );

const consume = (
  host: RuntimeHost<WorkerNeeds>,
  options: QueueWorkerOptions,
): Serving<OrderWorkerInfo> => {
  const { queue } = options;
  const concurrency = options.concurrency ?? 1;
  const maxAttempts = options.maxAttempts ?? 3;

  let accepting = true;
  let inFlight = 0;

  const pump = (): void => {
    while (accepting && inFlight < concurrency) {
      const delivery = queue.claim();
      if (delivery === undefined) return;

      inFlight += 1;
      // The unit's outcome is FOLDED to a value here rather than dropped:
      // `AsyncResult<T, never>` has an empty *error* channel, but a `Defect`
      // can still be present.
      void deliver(host, queue, delivery, maxAttempts).match({
        ok: () => released(),
        // Nothing can land in the error channel — a job's own failure became a
        // disposition inside the unit — so the matcher has no case to name.
        errCases: (matcher) => matcher,
        // Reached only if the disposition machinery itself failed, which leaves
        // the message neither acked nor requeued. Parking it is the one
        // remaining courtesy: a producer waiting on it gets an answer.
        defect: (cause) => {
          queue.settle({
            jobId: delivery.job.id,
            outcome: "dead-lettered",
            reason: String(cause),
            attempts: delivery.attempt,
          });
          released();
        },
      });
    }
  };

  const released = (): void => {
    inFlight -= 1;
    pump();
  };

  const unsubscribe = queue.subscribe(pump);

  const stopClaiming = (): void => {
    accepting = false;
    unsubscribe();
  };

  pump();

  return {
    info: { queue: queue.name, concurrency },
    drain: (signal) => {
      void signal;
      stopClaiming();
      return OkAsync();
    },
    stop: () => {
      stopClaiming();
      return OkAsync();
    },
  };
};

/**
 * `UnitMeta.id` must be unique per unit, and a *message* id is not: a retried
 * message is delivered twice and is two units. The delivery is the unit, so the
 * attempt is part of the id — and the message id becomes the `traceId`, which
 * is exactly what `traceId` is for. It is the correlation id, minted outside
 * this process, and it stays the same across every attempt, so all three
 * deliveries of a message join up in the log.
 */
const metaFor = (delivery: Delivery): UnitMeta => ({
  kind: "job",
  id: `${delivery.job.id}#${delivery.attempt}`,
  traceId: delivery.job.id,
});
