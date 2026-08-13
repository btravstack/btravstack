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
 * `kind` is what sort of thing changed, `id` is which one — the key a reader
 * keys its own copy on — and `payload` is what it now is. **A null payload is
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
    kind: z.literal("order"),
    id: z.string(),
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
 * The contract, declared before any implementation exists — the same
 * discipline `order-api-contract` and `order-temporal-contract` follow.
 *
 * A publisher entry is **structurally required**: `defineEventConsumer`
 * derives the binding from the publisher it consumes, so this package carries
 * the producing side (the outbox relay) and the consuming side (the
 * notifier) as one checkable artifact.
 */
export const orderContract = defineContract({
  publishers: { orderChanged: orderChangedEvent },
  consumers: { orderChanged: defineEventConsumer(orderChangedEvent, notifications) },
});

export type OrderContract = typeof orderContract;
