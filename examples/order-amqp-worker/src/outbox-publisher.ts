import type { TypedAmqpClient } from "@amqp-contract/client";
import { amqpClient } from "@btravstack/amqp-client";
import { AmqpConfig } from "@btravstack/amqp-worker";
import { Port, Provider, type ServiceOf } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { decodeOrderPayload } from "@btravstack/example-order-infrastructure";
import { OutboxPublisher } from "@btravstack/outbox";
import { OkAsync } from "unthrown";

/**
 * The client, as a port of its own: a resourceful provider hands `release` the
 * service it acquired, and the thing to close is the client, not the publisher
 * over it.
 */
class OrderAmqpClient extends Port("OrderAmqpClient")<TypedAmqpClient<typeof orderContract>> {}

export const orderAmqpClient = amqpClient(OrderAmqpClient, orderContract, AmqpConfig);

/**
 * What "publish" means for this application — the one half of the outbox
 * `@btravstack/outbox` cannot own. An outbox row becomes the contract's
 * `orderChanged` envelope; the payload is the `OrderPayload` JSON
 * `prismaOrderRepository` wrote — the life of the order it is about, which
 * rides as `placementId` and `placedAt`, and the order, whose `null` stays the
 * tombstone on the wire. A row still pending from before that encoding carries
 * the bare order, or `NULL` for a tombstone, and publishes without the two:
 * `decodeOrderPayload` reads both shapes, so such a row never blocks its
 * tenant. The row's id rides as
 * `eventId`, the key a subscriber deduplicates a re-delivery on.
 *
 * A message the contract refuses is an `Err` like a broker that refuses it:
 * the relay leaves it pending either way, and its health check names the
 * tenant that is falling behind.
 */
export const orderPublisher = Provider(OutboxPublisher)({
  inject: { client: OrderAmqpClient },
  sync: ({ client }): ServiceOf<OutboxPublisher> => ({
    publish: (message) =>
      // Parsed inside the pipeline: `JSON.parse` on a row this code wrote cannot
      // fail, and if it somehow does, the throw is this message's defect rather
      // than one escaping the relay's call.
      OkAsync()
        .map(() => decodeOrderPayload(message.payload))
        .flatMap(({ placedAt, placementId, order }) =>
          client.publish("orderChanged", {
            eventId: message.id,
            tenantId: message.tenantId,
            kind: message.kind as "order",
            id: message.subjectId,
            occurredAt: message.occurredAt.toISOString(),
            placedAt,
            placementId,
            payload: order,
          }),
        ),
  }),
});
