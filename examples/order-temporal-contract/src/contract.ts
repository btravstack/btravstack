import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * What an order looks like on the wire — the same shape `order-api`'s
 * `OrderView` is, and for the same reason: `Order`'s fields are branded
 * (`OrderId`, `Quantity`), and a brand is a compile-time fiction that does not
 * survive serialization. Temporal persists every activity input and output in
 * an event history, so the transport's shape has to be a real one.
 */
const orderView = z.object({ id: z.uuidv7().brand("OrderId"), quantity: z.number() });

/** The payload every declared error carries — which order it was about. */
const orderRef = z.object({ id: z.uuidv7().brand("OrderId") });

/**
 * What `InvalidOrderId` carries, and the one ref whose `id` is a bare
 * `string`. It names the id **as received**, which is precisely the value that
 * is not a UUIDv7 — validating it against `z.uuidv7()` would reject the only
 * payload this error is ever constructed with.
 */
const malformedRef = z.object({ id: z.string() });

/**
 * Every input carries the tenant, and that is not a field the domain gained:
 * it is who the work is being done for. A worker has no request and no
 * delivery to read it off, so a workflow is handed it by its caller and hands
 * it on to each activity, where `temporal({ tenantOf })` lifts it onto the
 * kernel's ambient unit record and the persistence adapters find it — the
 * same place the HTTP header and the AMQP envelope land.
 *
 * On the input rather than a Temporal header because an activity's input is
 * persisted in the event history: a replay a year later reconstructs the
 * tenant along with everything else, which is the whole promise of running
 * this on a durable platform.
 */
const tenanted = z.object({ tenantId: z.uuidv7() });

const orderInput = tenanted.extend({ orderId: z.uuidv7(), quantity: z.number() });
const orderTarget = tenanted.extend({ orderId: z.uuidv7() });

/**
 * The forward steps: three calls into the application layer, one external
 * service each. Their `errors` maps are the transport half of the
 * errors-as-values story, and they carry something neither oRPC nor a queue
 * expresses natively — **`nonRetryable`**. A modeled domain failure is a
 * permanent answer, so declaring it here is what stops Temporal's retry
 * policy asking the same impossible thing five more times. Anything NOT
 * declared is retried according to `activityOptions.retry`, which is exactly
 * the treatment a `Defect` deserves: an unmodelled failure is the
 * infrastructure one, and infrastructure comes back.
 */
const place = defineActivity({
  input: orderInput,
  output: orderView,
  errors: {
    InvalidQuantity: { data: orderRef, nonRetryable: true },
    InvalidOrderId: { data: malformedRef, nonRetryable: true },
    OrderAlreadyPlaced: { data: orderRef, nonRetryable: true },
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3, initialInterval: "10 milliseconds" },
  },
});

const reserveStock = defineActivity({
  input: orderInput,
  output: z.void(),
  errors: {
    OutOfStock: { data: orderRef, nonRetryable: true },
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3, initialInterval: "10 milliseconds" },
  },
});

const arrangeShipping = defineActivity({
  input: orderTarget,
  output: z.void(),
  errors: {
    ShippingUnavailable: { data: orderRef, nonRetryable: true },
  },
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3, initialInterval: "10 milliseconds" },
  },
});

/**
 * The compensations. No `errors` map on either: compensation is the saga
 * *un-deciding*, and a step that could answer "no" would leave the saga stuck
 * half-done. Whatever infrastructure trouble they hit is undeclared — so
 * Temporal retries it until it works, which is precisely the durability the
 * whole example runs on this platform to get.
 */
const releaseStock = defineActivity({
  input: orderTarget,
  output: z.void(),
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 5, initialInterval: "10 milliseconds" },
  },
});

const cancelPlacement = defineActivity({
  input: orderTarget,
  output: z.void(),
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 5, initialInterval: "10 milliseconds" },
  },
});

/**
 * The workflow: an orchestration, which is what Temporal is *for*. Place,
 * reserve, ship — and when a later step answers a permanent no, walk back the
 * earlier ones before answering the caller. The walk-back is the part no
 * single service can own, because it spans services; a durable workflow is
 * the one place the whole journey exists as code.
 *
 * The workflow re-declares the domain errors, and that is not duplication. A
 * contract error declared on an **activity** is rehydrated inside the
 * *workflow* — it never reaches the client on its own. A contract error
 * declared on the **workflow** is rehydrated at the *client*. So a domain
 * failure that a caller is entitled to branch on has to be named at both
 * boundaries. `workflows.ts` is where the hand-off — and the compensation —
 * happens.
 */
const fulfillOrder = defineWorkflow({
  input: orderInput,
  output: orderView,
  idempotency: "allow-duplicate",
  errors: {
    InvalidQuantity: { data: orderRef, nonRetryable: true },
    InvalidOrderId: { data: malformedRef, nonRetryable: true },
    OrderAlreadyPlaced: { data: orderRef, nonRetryable: true },
    OutOfStock: { data: orderRef, nonRetryable: true },
    ShippingUnavailable: { data: orderRef, nonRetryable: true },
  },
  activities: { place, reserveStock, arrangeShipping, releaseStock, cancelPlacement },
});

const amountInput = tenanted.extend({ orderId: z.uuidv7(), amount: z.number() });
const authorizationTarget = tenanted.extend({ authorizationId: z.string() });

const authorizePayment = defineActivity({
  input: amountInput,
  output: z.object({ authorizationId: z.string() }),
  errors: { PaymentDeclined: { data: orderRef, nonRetryable: true } },
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 3, initialInterval: "10 milliseconds" },
  },
});

const capturePayment = defineActivity({
  input: authorizationTarget,
  output: z.void(),
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 5, initialInterval: "10 milliseconds" },
  },
});

const refundPayment = defineActivity({
  input: authorizationTarget,
  output: z.void(),
  activityOptions: {
    startToCloseTimeout: "1 minute",
    retry: { maximumAttempts: 5, initialInterval: "10 milliseconds" },
  },
});

/**
 * The second workflow, and a second vertical: taking the money is not part of
 * fulfilling the order, and the worker polls one task queue for both. Its
 * compensation is `refundPayment` — declared with no `errors` map, like every
 * other compensation here, because un-deciding must not be able to answer no.
 */
const chargeOrder = defineWorkflow({
  input: amountInput,
  output: z.object({ authorizationId: z.string() }),
  idempotency: "allow-duplicate",
  errors: { PaymentDeclined: { data: orderRef, nonRetryable: true } },
  activities: { authorizePayment, capturePayment, refundPayment },
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
  workflows: { fulfillOrder, chargeOrder },
});

export type OrderContract = typeof orderContract;
