import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * What an order looks like on the wire — the same shape `order-api`'s
 * `OrderView` is, and for the same reason: `Order`'s fields are branded
 * (`OrderId`, `Quantity`), and a brand is a compile-time fiction that does not
 * survive serialization. Temporal persists every activity input and output in
 * an event history, so the transport's shape has to be a real one.
 */
const orderView = z.object({ id: z.string(), quantity: z.number() });

/** The payload every declared error carries — which order it was about. */
const orderRef = z.object({ id: z.string() });

/**
 * The activity: one call into the application layer.
 *
 * Its `errors` map is the transport half of the errors-as-values story, and it
 * carries something neither oRPC nor a queue expresses natively —
 * **`nonRetryable`**. A modeled domain failure is a permanent answer, so
 * declaring it here is what stops Temporal's retry policy asking the same
 * impossible thing five more times. Anything NOT declared here is retried
 * according to `activityOptions.retry`, which is exactly the treatment a
 * `Defect` deserves: an unmodelled failure is the infrastructure one, and
 * infrastructure comes back.
 */
const place = defineActivity({
  input: z.object({ orderId: z.string(), quantity: z.number() }),
  output: orderView,
  errors: {
    InvalidQuantity: { data: orderRef, nonRetryable: true },
    OrderAlreadyPlaced: { data: orderRef, nonRetryable: true },
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3, initialInterval: "10 milliseconds" },
  },
});

/**
 * The workflow re-declares the same two errors, and that is not duplication.
 *
 * A contract error declared on an **activity** is rehydrated inside the
 * *workflow* — it never reaches the client on its own. A contract error
 * declared on the **workflow** is rehydrated at the *client*. So a domain
 * failure that a caller is entitled to branch on has to be named at both
 * boundaries, which is Temporal's version of the triage `order-api` performs
 * once in `router.ts`. `workflows.ts` is where the hand-off happens.
 */
const placeOrder = defineWorkflow({
  input: z.object({ orderId: z.string(), quantity: z.number() }),
  output: orderView,
  idempotency: "allow-duplicate",
  errors: {
    InvalidQuantity: { data: orderRef, nonRetryable: true },
    OrderAlreadyPlaced: { data: orderRef, nonRetryable: true },
  },
  activities: { place },
});

/**
 * The contract, declared before any implementation exists — the same discipline
 * `order-api/src/contract.ts` follows.
 *
 * `taskQueue` is part of it because a Temporal worker's identity *is* its task
 * queue: `TypedWorker.create` reads it off the contract rather than taking it
 * as an option. Specs scope a per-test queue with `withTaskQueue`.
 */
export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { placeOrder },
});

export type OrderContract = typeof orderContract;
