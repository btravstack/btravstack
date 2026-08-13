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
 */
const orderPlaced = defineMessage(z.object({ orderId: z.string(), quantity: z.number() }));

const orderPlacedEvent = defineEventPublisher(orders, orderPlaced, {
  routingKey: "order.placed",
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
  publishers: { orderPlaced: orderPlacedEvent },
  consumers: { orderPlaced: defineEventConsumer(orderPlacedEvent, notifications) },
});

export type OrderContract = typeof orderContract;
