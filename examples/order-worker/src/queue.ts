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
   * Publishes a job and resolves when it **settles** — acked or dead-lettered,
   * however many deliveries that took. An `AsyncResult`, like every other async
   * surface in this stack, with an empty error channel: a settlement always
   * arrives, because the worker's attempt budget is finite.
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
  const settlements = new Map<string, (settlement: Settlement) => void>();
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
          settlements.set(job.id, resolve);
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
      const resolve = settlements.get(settlement.jobId);
      settlements.delete(settlement.jobId);
      if (resolve !== undefined) resolve(settlement);
    },

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
