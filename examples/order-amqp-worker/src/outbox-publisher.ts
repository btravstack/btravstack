import { TypedAmqpClient } from "@amqp-contract/client";
import { AmqpConfig } from "@btravstack/amqp-worker";
import { Port, Provider, type ServiceOf } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import type { OrderPayload } from "@btravstack/example-order-infrastructure";
import { OutboxPublisher } from "@btravstack/outbox";
import { OkAsync, P, TaggedError } from "unthrown";

/**
 * The broker at `AMQP_URL` did not answer when the publisher opened its client.
 * Modeled rather than left the defect `TypedAmqpClient.create` reports it as, so
 * `runMain` exits `1` — an operator can act on it, and neither a wrong URL nor a
 * broker that is down is a bug in this code.
 */
export class BrokerUnreachable extends TaggedError("BrokerUnreachable")<{
  readonly url: string;
  readonly cause: unknown;
}> {}

/**
 * The client, as a port of its own: a resourceful provider hands `release` the
 * service it acquired, and the thing to close is the client, not the publisher
 * over it.
 */
class OrderAmqpClient extends Port("OrderAmqpClient")<TypedAmqpClient<typeof orderContract>> {}

/**
 * Created here rather than borrowed from the worker: a transport connection is
 * the transport's own, and it is not a second one — the connection manager
 * pools by URL, so this shares the consumer's TCP connection and `close()`
 * releases a lease rather than the socket. A broker it cannot reach fails
 * startup.
 */
export const orderAmqpClient = Provider(OrderAmqpClient)({
  inject: { broker: AmqpConfig },
  acquire: ({ broker: { url } }) =>
    TypedAmqpClient.create({ contract: orderContract, urls: [url] }).mapErrCases((matcher) =>
      matcher.with(
        P.tag("@amqp-contract/ConnectionError"),
        (cause) => new BrokerUnreachable({ url, cause }),
      ),
    ),
  release: (client) => client.close().get(),
});

/**
 * What "publish" means for this application — the one half of the outbox
 * `@btravstack/outbox` cannot own. An outbox row becomes the contract's
 * `orderChanged` envelope; the payload is the `OrderPayload` JSON
 * `prismaOrderRepository` wrote — the order's placement time, which rides as
 * `placedAt`, and the order, whose `null` stays the tombstone on the wire. The row's id rides as
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
        .map(() => JSON.parse(message.payload ?? "null") as OrderPayload)
        .flatMap(({ placedAt, order }) =>
          client.publish("orderChanged", {
            eventId: message.id,
            tenantId: message.tenantId,
            kind: message.kind as "order",
            id: message.subjectId,
            occurredAt: message.occurredAt.toISOString(),
            placedAt,
            payload: order,
          }),
        ),
  }),
});
