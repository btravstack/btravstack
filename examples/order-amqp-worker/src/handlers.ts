import { AmqpHandlers } from "@btravstack/amqp";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import { Logger } from "@btravstack/example-order-application";
import { OkAsync } from "unthrown";

/**
 * The consuming half: the handlers record `orderContract` wants, one per
 * consumer, as a service the starter resolves like any other.
 * `AmqpHandlers(orderContract)` is di's own `Provider` on the starter's
 * handlers port, typed for the contract — no class, no name: a consumer serves
 * one handlers record — so the provider declares what the handlers need — here
 * `Logger` — and is built by di from it, exactly as a use case is. The contract is what types
 * the record: `orderChanged` is a plain function of the message it declares,
 * with nothing to wrap it in.
 *
 * The one handler — a subscriber like any other service would write, reacting
 * to a fact somebody else committed. It has no domain errors to triage:
 * notifying is a `Logger.info` here, and a real notifier's failures would be
 * retryable infrastructure, not answers about the order.
 *
 * The `payload === null` branch is the whole point of the envelope: one
 * handler, one stream, and a reader that keeps its own copy of a subject
 * upserts on a payload and drops on a tombstone. There is no second message
 * type to declare, subscribe to, or keep ordered against this one.
 */
export const orderHandlers = AmqpHandlers(orderContract)([Logger], {
  sync: (logger) => ({
    orderChanged: (message) => {
      const { id, payload } = message.payload;
      logger.info(
        payload === null
          ? `order ${id} is gone — notifying`
          : `order ${id} placed — notifying (${payload.quantity} items)`,
      );
      return OkAsync();
    },
  }),
});
