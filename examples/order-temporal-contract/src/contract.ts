import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { z } from "zod";

/**
 * What an order looks like on the wire. Temporal persists every activity input
 * and output in an event history, so the transport's shape has to be a real one
 * rather than the entity's branded fields.
 */
const orderView = z.object({ id: z.uuidv7().brand("OrderId"), quantity: z.number() });

/** The payload every declared error carries — which order it was about. */
const orderRef = z.object({ id: z.uuidv7().brand("OrderId") });

/**
 * What `InvalidOrderId` carries, and the one ref whose `id` is a bare `string`:
 * it names the id **as received**, which by definition is not a UUIDv7.
 */
const malformedRef = z.object({ id: z.string() });

/**
 * Every input carries the tenant: it is who the work is being done for. A worker
 * has no request or delivery to read it off, so a workflow is handed it by its
 * caller and hands it on to each activity, which passes it to the ports that
 * name it. The starter reads nothing about tenancy.
 *
 * On the input rather than a Temporal header because an activity's input is
 * persisted in the event history: a replay a year later reconstructs the tenant
 * along with everything else.
 */
const tenanted = z.object({ tenantId: z.uuidv7() });

const orderInput = tenanted.extend({ orderId: z.uuidv7(), quantity: z.number() });
const orderTarget = tenanted.extend({ orderId: z.uuidv7() });

/**
 * The forward steps. Their `errors` maps carry something neither oRPC nor a
 * queue expresses natively — **`nonRetryable`**: a modeled domain failure is a
 * permanent answer, so declaring it stops the retry policy asking the same
 * impossible thing again. Anything NOT declared is retried, which is the
 * treatment a `Defect` deserves — infrastructure comes back.
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
 * un-deciding, and a step that could answer "no" would leave it stuck half-done.
 * Whatever infrastructure trouble they hit is undeclared, so Temporal retries it
 * until it works.
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
 * The workflow: place, reserve, ship — and when a later step answers a permanent
 * no, walk back the earlier ones before answering the caller. The walk-back is
 * the part no single service can own, because it spans services.
 *
 * Re-declaring the domain errors is not duplication: an error declared on an
 * ACTIVITY is rehydrated inside the workflow, one declared on the WORKFLOW at
 * the client — so a failure a caller may branch on is named at both boundaries.
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
 * fulfilling the order, and the worker polls one task queue for both.
 */
const chargeOrder = defineWorkflow({
  input: amountInput,
  output: z.object({ authorizationId: z.string() }),
  idempotency: "allow-duplicate",
  errors: { PaymentDeclined: { data: orderRef, nonRetryable: true } },
  activities: { authorizePayment, capturePayment, refundPayment },
});

/**
 * The contract, declared before any implementation exists.
 *
 * `taskQueue` is part of it because a Temporal worker's identity IS its task
 * queue, read off the contract rather than taken as an option. Specs scope a
 * per-test queue with `withTaskQueue`.
 */
export const orderContract = defineContract({
  taskQueue: "orders",
  workflows: { fulfillOrder, chargeOrder },
});

export type OrderContract = typeof orderContract;
