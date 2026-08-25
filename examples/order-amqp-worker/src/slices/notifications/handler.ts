import { RetryableError } from "@amqp-contract/worker";
import { AmqpHandler } from "@btravstack/amqp-worker";
import { currentUnit, Logger } from "@btravstack/core";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Mailer } from "@btravstack/mailer";
import { ErrAsync, P } from "unthrown";

/**
 * The notifying subscriber: one consumer of the broadcast, as a provider on a
 * port of its own. `AmqpHandler(orderContract, "orderNotifications")` mints
 * that port from the contract key, so there is no class and no name here, and
 * the handler is typed by the one consumer it implements — an envelope that
 * drifted is a compile error in this file rather than at the composition root.
 *
 * It declares only what it calls: `Logger` and `Mailer`, and nothing the
 * audit slice needs.
 *
 * The mail is what the slice is for, and its failure arm is the interesting
 * half: a `MailNotSent` becomes a `RetryableError`, so the delivery is left
 * un-acked and the BROKER's retry budget owns redelivery — thesis #3 one
 * layer out, with the transport mapping an outcome the thing that produced
 * it declined to.
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
  { logger: Logger, mailer: Mailer },
  {
    sync:
      ({ logger, mailer }) =>
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

        return mailer
          .send({
            from: "orders@example.test",
            // A real application looks the address up; this one derives it,
            // because who a tenant notifies is its own business and not this
            // example's subject.
            to: [`tenant-${tenantId}@example.test`],
            subject: payload === null ? `order ${id} withdrawn` : `order ${id} placed`,
            text:
              payload === null
                ? `Order ${id} is no longer with us.`
                : `Order ${id} is placed, for ${payload.quantity} items.`,
          })
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("MailNotSent"),
              (error) =>
                new RetryableError(
                  `the notification for order ${id} was not sent: ${error.reason}`,
                ),
            ),
          );
      },
  },
);
