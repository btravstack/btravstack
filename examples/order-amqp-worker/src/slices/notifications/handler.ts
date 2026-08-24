import { RetryableError } from "@amqp-contract/worker";
import { AmqpHandler } from "@btravstack/amqp";
import { currentUnit, Logger } from "@btravstack/core";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { ErrAsync, OkAsync } from "unthrown";

/**
 * The notifying subscriber: one consumer of the broadcast, as a provider on a
 * port of its own. `AmqpHandler(orderContract, "orderNotifications")` mints
 * that port from the contract key, so there is no class and no name here, and
 * the handler is typed by the one consumer it implements — an envelope that
 * drifted is a compile error in this file rather than at the composition root.
 *
 * It declares only what it calls: `Logger`, and nothing the audit slice needs.
 *
 * The `payload === null` branch is the whole point of the envelope: one
 * handler, one stream, and a reader that keeps its own copy of a subject
 * upserts on a payload and drops on a tombstone.
 *
 * It also honours the kernel's deadline. `currentUnit()?.signal` is aborted
 * when the drain runs out of time, and a delivery this process is no longer
 * waiting for should not have a notification sent on its behalf: answering a
 * `RetryableError` leaves the message un-acked, so the broker hands it to the
 * next worker.
 */
export const orderNotifications = AmqpHandler(orderContract, "orderNotifications")(
  { logger: Logger },
  {
    sync:
      ({ logger }) =>
      ({ payload: { tenantId, id, payload } }) => {
        if (currentUnit()?.signal.aborted === true) {
          return ErrAsync(
            new RetryableError(`the drain deadline passed before order ${id} was notified`),
          );
        }
        logger.info(payload === null ? "order gone — notifying" : "order placed — notifying", {
          tenantId,
          orderId: id,
          ...(payload === null ? {} : { quantity: payload.quantity }),
        });
        return OkAsync();
      },
  },
);
