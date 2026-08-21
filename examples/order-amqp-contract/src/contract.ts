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
 * something that already committed. Nothing here is a command — nobody is
 * asked to do anything, and the publisher does not know who is listening.
 * That is what separates this deployment from the Temporal one: AMQP carries
 * announcements, orchestration carries intent.
 *
 * The envelope is the whole vocabulary a reader needs to rebuild state:
 * `tenantId` is whose it is, `kind` is what sort of thing changed, `id` is
 * which one — the key a reader keys its own copy on, WITHIN a tenant — and
 * `payload` is what it now is. The tenant is on the wire rather than left
 * ambient because a broadcast crosses processes: the relay reads it off the
 * outbox row, and the subscriber's runtime puts it back on ITS ambient record
 * (`amqp({ tenantOf })`), which is where the subscriber's own adapters find
 * it again. **A null payload is
 * the tombstone**, the last word about a subject, saying it is gone. So the
 * first event for an id creates, later ones with a payload replace, and the
 * null one deletes; a subscriber needs no other event types and no schema
 * change when a fourth verb shows up.
 *
 * `occurredAt` is an ISO string rather than a `Date` because JSON has no date
 * type and the wire is JSON — the shape has to be one that survives the trip.
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
 * services bind their own queues to the same `orders` exchange without
 * touching this contract — that is the broadcast working as intended; this
 * queue exists so the repo ships one end-to-end reader.
 *
 * The policy is contract configuration the broker enforces — the sharper form
 * of the claim the Temporal contract makes with `nonRetryable`: naming a
 * failure decides not only what the caller sees but what the platform does
 * next.
 *
 * `externalConsumers: true` on the dead letter is required, not decorative:
 * `defineContract` runs a define-time routability check that rejects a DLX
 * nothing binds to — a queue nothing here parks messages *out of* would
 * otherwise be silent message loss the check is built to catch. This contract
 * has no consumer for `orders-dlx` because parking is the point.
 */
const notifications = defineQueue("order-notifications", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});

/**
 * The second subscriber's queue. Two queues bound to the same `orders`
 * exchange is what a broadcast IS: neither subscriber knows the other exists,
 * each keeps its own retry budget, and one slow reader cannot stall the other.
 * It is also why this contract has two consumers of ONE publisher rather than
 * two events.
 */
const audit = defineQueue("order-audit", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});

/**
 * The contract, declared before any implementation exists — the same
 * discipline `order-api-contract` and `order-temporal-contract` follow.
 *
 * A publisher entry is **structurally required**: `defineEventConsumer`
 * derives the binding from the publisher it consumes, so this package carries
 * the producing side (the outbox relay) and the consuming side (the
 * subscribers) as one checkable artifact.
 *
 * The consumer keys name the subscriber, not the event: `orderNotifications`
 * and `orderAudit` both read `orderChanged`, and the worker's two slices are
 * each named for the key it implements.
 */
export const orderContract = defineContract({
  publishers: { orderChanged: orderChangedEvent },
  consumers: {
    orderNotifications: defineEventConsumer(orderChangedEvent, notifications),
    orderAudit: defineEventConsumer(orderChangedEvent, audit),
  },
});

export type OrderContract = typeof orderContract;
