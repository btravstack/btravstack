import {
  defineContract,
  defineEventConsumer,
  defineEventPublisher,
  defineExchange,
  defineMessage,
  defineQueue,
} from "@amqp-contract/contract";
import { z } from "zod";

const orders = defineExchange("orders");
const parked = defineExchange("orders-dlx", { type: "direct" });

/**
 * The event this contract exists to broadcast: a fact, past tense, about
 * something that already committed. Nothing here is a command — AMQP carries
 * announcements, orchestration carries intent.
 *
 * The envelope is the whole vocabulary a reader needs to rebuild state. The
 * tenant is on the wire rather than left ambient because a broadcast crosses
 * processes, and the starter reads nothing about tenancy. **A null payload is
 * the tombstone**: the first event for an id creates, later ones with a payload
 * replace, and the null one deletes — so a subscriber needs no other event types
 * when a fourth verb shows up.
 *
 * `occurredAt` is an ISO string rather than a `Date` because the wire is JSON.
 */
const orderChanged = defineMessage(
  z.object({
    tenantId: z.uuidv7(),
    kind: z.literal("order"),
    id: z.uuidv7(),
    occurredAt: z.string(),
    payload: z.object({ quantity: z.number() }).nullable(),
  }),
);

/**
 * One routing key for every change, not one per verb: a reader that compacts
 * by `id` needs a subject's create and its tombstone in **one ordered
 * stream**, and two routing keys are two queues and no order between them.
 */
const orderChangedEvent = defineEventPublisher(orders, orderChanged, {
  routingKey: "order.changed",
});

/**
 * One subscriber's queue, and the one place its retry budget lives. Other
 * services bind their own queues to the same `orders` exchange without touching
 * this contract — the broadcast working as intended.
 *
 * `externalConsumers: true` on the dead letter is required, not decorative:
 * `defineContract`'s routability check rejects a DLX nothing binds to, which
 * would otherwise be the silent message loss it exists to catch. This contract
 * has no consumer for `orders-dlx`, because parking is the point.
 */
const notifications = defineQueue("order-notifications", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});

/**
 * The second subscriber's queue. Two queues bound to the same exchange is what a
 * broadcast IS: neither subscriber knows the other exists, each keeps its own
 * retry budget, and one slow reader cannot stall the other — which is why this
 * contract has two consumers of ONE publisher rather than two events.
 */
const audit = defineQueue("order-audit", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});

/**
 * The contract, declared before any implementation exists.
 *
 * A publisher entry is **structurally required**: `defineEventConsumer` derives
 * the binding from the publisher it consumes, so the producing and consuming
 * sides are one checkable artifact.
 *
 * The consumer keys name the subscriber, not the event — both read
 * `orderChanged`, and the worker's slices are each named for the key it
 * implements.
 */
export const orderContract = defineContract({
  publishers: { orderChanged: orderChangedEvent },
  consumers: {
    orderNotifications: defineEventConsumer(orderChangedEvent, notifications),
    orderAudit: defineEventConsumer(orderChangedEvent, audit),
  },
});

export type OrderContract = typeof orderContract;
