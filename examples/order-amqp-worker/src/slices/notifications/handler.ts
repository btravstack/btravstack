import { NonRetryableError, RetryableError } from "@amqp-contract/worker";
import { AmqpHandler } from "@btravstack/amqp-worker";
import { currentUnit, Logger } from "@btravstack/core";
import type { ServiceOf } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Tenant } from "@btravstack/example-order-application";
import { Mailer } from "@btravstack/mailer";
import { Storage, type PresignNotSupported, type StorageUnavailable } from "@btravstack/storage";
import { ErrAsync, OkAsync, P, type AsyncResult } from "unthrown";

/**
 * Where an order's invoice lives. The tenant is in the key because the port
 * has no slot for one — the rule the cache key and the Temporal confirmation
 * follow, for the same reason.
 */
const invoiceKey = (tenantId: string, orderId: string): string =>
  `invoices/${tenantId}/${orderId}.txt`;

/** A week: the longest a SigV4 presigned URL may live, and a mail is read late. */
const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The link a notification carries, if there is one to carry.
 *
 * A placement renders the invoice, stores it and presigns it — the store is
 * the only thing that serves it, so the bytes never pass through a mail.
 *
 * A withdrawal links the invoice the placement issued, and has to READ it
 * first: presigning asks the store nothing, so a URL for a key nobody stored
 * is minted happily and 404s when followed. `ObjectNotFound` is therefore an
 * ordinary answer here — an invoice a retention rule already reaped, or a
 * placement that never got one — and the mail goes out without a link.
 */
const invoiceLink = (
  storage: ServiceOf<Storage>,
  tenantId: string,
  id: string,
  payload: { readonly quantity: number } | null,
): AsyncResult<string | undefined, StorageUnavailable | PresignNotSupported> => {
  const key = invoiceKey(tenantId, id);
  const issued =
    payload === null
      ? storage
          .get(key)
          .map((): string | undefined => key)
          .flatMapErrCases((matcher) =>
            matcher
              .with(P.tag("ObjectNotFound"), () => OkAsync(undefined))
              .with(P.tag("StorageUnavailable"), (error) => ErrAsync(error)),
          )
      : storage
          .put(
            key,
            new TextEncoder().encode(`Invoice for order ${id}: ${payload.quantity} items.`),
            {
              contentType: "text/plain",
            },
          )
          .map((): string | undefined => key);
  return issued.flatMap((found) =>
    found === undefined ? OkAsync(undefined) : storage.presignedUrl(found, { ttlMs: LINK_TTL_MS }),
  );
};

/**
 * The notifying subscriber: one consumer of the broadcast, as a provider on a
 * port of its own. `AmqpHandler(orderContract, "orderNotifications")` mints
 * that port from the contract key, so there is no class and no name here, and
 * the handler is typed by the one consumer it implements — an envelope that
 * drifted is a compile error in this file rather than at the composition root.
 *
 * It declares only what it calls: `Logger`, `Mailer` and the `Storage` the
 * invoice lives in, and nothing the audit slice needs. The tenant comes off
 * `context.unit`, where `MessageUnitModule` claimed it from the very envelope
 * this handler is reading — the same fact, claimed once.
 *
 * The mail is what the slice is for, and its failure arms are the interesting
 * half: a `MailNotSent` or a store that would not answer becomes a
 * `RetryableError`, so the BROKER's retry budget owns redelivery — thesis #3
 * one layer out, with the transport mapping an outcome the thing that
 * produced it declined to. A store that cannot presign at all is a
 * `NonRetryableError`: no redelivery teaches it to, so the message is parked.
 *
 * The `payload === null` branch is the whole point of the envelope: one
 * handler, one stream, and a reader that keeps its own copy of a subject
 * upserts on a payload and drops on a tombstone.
 *
 * It also honours the kernel's deadline. `currentUnit()?.signal` is aborted
 * when the drain runs out of time, and a delivery this process is no longer
 * waiting for should not have a notification sent on its behalf: answering a
 * `RetryableError` hands the message to the next worker. Note what that COSTS
 * — `@amqp-contract/worker` acks the original and republishes a copy carrying
 * `x-retry-count + 1`, rather than leaving it un-acked — so a rollout spends
 * one attempt per in-flight message, and `maxRetries` has to have room for it.
 */
export const orderNotifications = AmqpHandler(
  orderContract,
  "orderNotifications",
)({
  inject: { logger: Logger, mailer: Mailer, storage: Storage },
  unit: { tenant: Tenant },
  sync:
    ({ logger, mailer, storage }) =>
    ({
      context,
      input: {
        payload: { id, payload },
      },
    }) => {
      const tenantId = context.unit.tenant;
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

      return invoiceLink(storage, tenantId, id, payload)
        .flatMap((link) =>
          mailer.send({
            from: "orders@example.test",
            // A real application looks the address up; this one derives it,
            // because who a tenant notifies is its own business and not this
            // example's subject.
            to: [`tenant-${tenantId}@example.test`],
            subject: payload === null ? `order ${id} withdrawn` : `order ${id} placed`,
            text:
              (payload === null
                ? `Order ${id} is no longer with us.`
                : `Order ${id} is placed, for ${payload.quantity} items.`) +
              (link === undefined ? "" : ` Its invoice: ${link}`),
          }),
        )
        .mapErrCases((matcher) =>
          matcher
            .with(
              P.tag("MailNotSent"),
              (error) =>
                new RetryableError(
                  `the notification for order ${id} was not sent: ${error.reason}`,
                ),
            )
            .with(
              P.tag("StorageUnavailable"),
              (error) =>
                new RetryableError(`the invoice for order ${id} is out of reach: ${error.reason}`),
            )
            .with(
              P.tag("PresignNotSupported"),
              () => new NonRetryableError(`the invoice store cannot link order ${id}'s invoice`),
            ),
        );
    },
});
