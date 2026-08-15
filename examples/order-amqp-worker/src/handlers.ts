import { declareHandler, type WorkerInferHandlers } from "@amqp-contract/worker";
import { Port, Provider } from "@btravstack/di";
import { orderContract, type OrderContract } from "@btravstack/example-order-amqp-contract";
import { Logger } from "@btravstack/example-order-application";
import { OkAsync } from "unthrown";

/**
 * The consuming half, as a port: the handlers record `orderContract` wants,
 * one per consumer, which `amqp({ handlers: OrderHandlers })` resolves like
 * any other service. It is a port rather than a value so its provider can
 * declare what the handlers need — here `Logger` — and be built by di from
 * it, exactly as a use case is.
 */
export class OrderHandlers extends Port("OrderHandlers")<WorkerInferHandlers<OrderContract>> {}

/**
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
export const orderHandlers = Provider(OrderHandlers)([Logger], {
  sync: (logger) => ({
    orderChanged: declareHandler(orderContract, "orderChanged", (message) => {
      const { id, payload } = message.payload;
      logger.info(
        payload === null
          ? `order ${id} is gone — notifying`
          : `order ${id} placed — notifying (${payload.quantity} items)`,
      );
      return OkAsync();
    }),
  }),
});
