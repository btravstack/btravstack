import { fromSafePromise, type AsyncResult } from "unthrown";

/**
 * One message: place this order, this many items.
 *
 * `id` is the **message** id, minted by whoever published it, and it is
 * deliberately not the order id — a message can be delivered more than once,
 * and correlating those deliveries is exactly what it is for.
 */
export type PlaceOrderJob = {
  readonly id: string;
  readonly orderId: string;
  readonly quantity: number;
};

/** One **delivery** of a message: the job, and which attempt this is. */
export type Delivery = { readonly job: PlaceOrderJob; readonly attempt: number };

/**
 * How a message ended, once it is no longer the broker's problem. A retry is
 * not here on purpose: it is not an ending, it is another delivery.
 */
export type Settlement =
  | { readonly jobId: string; readonly outcome: "acked"; readonly attempts: number }
  | {
      readonly jobId: string;
      readonly outcome: "dead-lettered";
      readonly reason: string;
      readonly attempts: number;
    };

/**
 * The broker, reduced to the four things a worker actually needs of one — plus
 * `publish`, which is the producer's half.
 *
 * It is a plain in-memory object rather than a di port because it is the
 * *transport*, not an application capability: the runtime owns it exactly as
 * the oRPC runtime owns its `node:http` server, and nothing in the application
 * or persistence layers can name it. A real deployment swaps this for an AMQP
 * channel and the runtime above is unchanged.
 */
export type OrderQueue = {
  readonly name: string;
  /**
   * Publishes a job and resolves when a **running worker settles** it — acked
   * or dead-lettered, however many deliveries that took.
   *
   * That is a precondition, not a guarantee. The attempt budget bounds the
   * retries of a job a worker has *claimed*; nothing bounds the wait for a
   * claim. A job published with no worker running, or left in the queue when
   * one stops or drains, is never settled and **awaiting it waits forever** —
   * which is what a broker does with an unconsumed message, rather than a
   * defect of this one. `queue-runtime.spec.ts` pins both halves.
   *
   * The empty error channel is honest about something narrower: publishing
   * itself cannot fail, and a dead-letter is a settlement rather than an error.
   *
   * Resolving on the *consumer's* outcome is a deliberate test convenience: a
   * real AMQP `publish` resolves on the broker's ack and the producer never
   * learns how the message ended. It is what lets a spec be the producer half
   * and assert the disposition in one `expect` — and it is why awaiting one is
   * only ever safe under a serving worker.
   */
  readonly publish: (job: PlaceOrderJob) => AsyncResult<Settlement, never>;
  /** Consumer side: take the next delivery, or `undefined` if there is none. */
  readonly claim: () => Delivery | undefined;
  /** Consumer side: hand a delivery back for one more attempt. */
  readonly requeue: (delivery: Delivery) => void;
  /** Consumer side: this message is finished with. */
  readonly settle: (settlement: Settlement) => void;
  /** Consumer side: wake up when there is something to claim. Unsubscribes. */
  readonly subscribe: (listener: () => void) => () => void;
};

export const createOrderQueue = (name = "orders"): OrderQueue => {
  const pending: Delivery[] = [];
  // Every waiter for an id, not the latest one. A message id is the producer's
  // to mint, so two publishes can carry the same one before either settles —
  // and a single-resolver map would silently overwrite the first, whose
  // `AsyncResult` then never settles at all. An awaiting producer would hang
  // with no error and no timeout, which is the worst shape a bug can take here.
  const settlements = new Map<string, ((settlement: Settlement) => void)[]>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    name,

    publish: (job) =>
      fromSafePromise(
        // The executor runs synchronously, so the message is queued before
        // `publish` returns — a worker already pumping picks it up on this
        // very tick.
        new Promise<Settlement>((resolve) => {
          // Appended in place rather than rebuilt: reusing an id is the case
          // this map now exists to support, and copying the array on each
          // publish would make that path quadratic for no benefit.
          const waiters = settlements.get(job.id);
          if (waiters === undefined) settlements.set(job.id, [resolve]);
          else waiters.push(resolve);

          pending.push({ job, attempt: 1 });
          notify();
        }),
      ),

    claim: () => pending.shift(),

    requeue: (delivery) => {
      pending.push({ job: delivery.job, attempt: delivery.attempt + 1 });
      notify();
    },

    settle: (settlement) => {
      const waiters = settlements.get(settlement.jobId) ?? [];
      settlements.delete(settlement.jobId);
      for (const resolve of waiters) resolve(settlement);
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
