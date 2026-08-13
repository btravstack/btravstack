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
 * The queue, and the one place this deployment's retry budget lives.
 *
 * `order-worker` spells the same policy as a `MAX_ATTEMPTS` constant and an
 * `if` in its runtime; here it is contract configuration the broker enforces,
 * which is the sharper form of the same claim the Temporal contract makes
 * with `nonRetryable`: naming a failure decides not only what the caller sees
 * but what the platform does next.
 *
 * `externalConsumers: true` on the dead letter is required, not decorative:
 * `defineContract` runs a define-time routability check that rejects a DLX
 * nothing binds to — a queue nothing here parks messages *out of* would
 * otherwise be silent message loss the check is built to catch. This
 * contract has no consumer for `orders-dlx` because parking is the point;
 * the flag says that deliberately, the same way `order-worker`'s own
 * suite does for the identical shape.
 */
const placements = defineQueue("order-placements", {
  deadLetter: { exchange: parked, externalConsumers: true },
  retry: { mode: "ttl-backoff", maxRetries: 3, initialDelayMs: 10 },
});

const placeOrder = defineMessage(z.object({ orderId: z.string(), quantity: z.number() }));

const orderPlacementRequested = defineEventPublisher(orders, placeOrder, {
  routingKey: "order.placement.requested",
});

/**
 * The contract, declared before any implementation exists — the same
 * discipline `order-api-contract` and `order-temporal-contract` follow.
 *
 * A publisher entry is **structurally required**: `defineEventConsumer`
 * derives the binding from the publisher it consumes, so this package
 * carries the producing side whether or not this repo ships a producer.
 */
export const orderContract = defineContract({
  publishers: { placeOrder: orderPlacementRequested },
  consumers: { placeOrder: defineEventConsumer(orderPlacementRequested, placements) },
});

export type OrderContract = typeof orderContract;
