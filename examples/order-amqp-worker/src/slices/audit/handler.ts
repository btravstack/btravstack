import { AmqpHandler } from "@btravstack/amqp-worker";
import { Logger } from "@btravstack/core";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { OkAsync } from "unthrown";

/**
 * The auditing subscriber: the same broadcast, its own queue, its own retry
 * budget, and a reading of the event that has nothing to do with the
 * notifier's. It records what happened; it never decides anything, so it has
 * no domain error to triage and nothing to answer but ack.
 *
 * It does NOT honour the drain deadline the way the notifier does, and that is
 * the point of having two: an audit line for a delivery already in hand is
 * still worth writing, where a notification for one nobody is waiting on is
 * not. What a slice answers when the kernel stops waiting is the slice's own
 * business.
 */
export const orderAudit = AmqpHandler(
  orderContract,
  "orderAudit",
)({
  inject: { logger: Logger },
  sync:
    ({ logger }) =>
    ({ payload: { tenantId, id, occurredAt, payload } }) => {
      logger.info("recording an order change", {
        tenantId,
        orderId: id,
        occurredAt,
        change: payload === null ? "removed" : "placed",
      });
      return OkAsync();
    },
});
