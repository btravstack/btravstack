import { declareHandler } from "@amqp-contract/worker";
import {
  amqpRuntime,
  messageUnits,
  type AmqpInfo,
  type MessageUnitContext,
} from "@btravstack/amqp";
import { RuntimePort, type Runtime } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { orderContract, type OrderContract } from "@btravstack/example-order-amqp-contract";
import { Logger, Outbox } from "@btravstack/example-order-application";
import { OkAsync } from "unthrown";

import { startOutboxRelay, type RelayOptions } from "./outbox-relay.js";

/**
 * The ports this runtime resolves out of the application context: `Outbox`
 * for the relay half, `Logger` for both halves. `PlaceOrder` is deliberately
 * absent — nothing on a broadcast consumes a command, and a runtime declares
 * what *it* needs rather than what the module happens to export.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something
 * (`src/needs-gate.test-d.ts` pins both directions).
 */
type AmqpNeeds = typeof Outbox | typeof Logger;

/**
 * The port `start` resolves this deployment's runtime from. `@btravstack/amqp`
 * ships no port of its own — a consumer's `needs` are the application's, so
 * the port carrying them in its type is the application's to declare — which
 * is why it is declared here, over the kernel's `RuntimePort`, and not
 * imported.
 */
export class OrderAmqpRuntime extends RuntimePort<Runtime<AmqpNeeds, AmqpInfo>> {}

/** What only the process knows: the broker, and the relay's own knobs. */
export type OrderAmqpOptions = {
  /** The broker URLs the worker and the relay both connect to. */
  readonly urls: readonly string[];
  /** The relay's own knobs. */
  readonly relay: Pick<RelayOptions, "pollMs">;
};

/**
 * The runtime as a module — `orderAmqpRuntime` provided on `OrderAmqpRuntime`,
 * the way `@btravstack/http`'s `httpModule` provides `HttpRuntime`. The
 * composition root imports it and exports the port, and `start` finds it.
 */
export const amqpModule = (options: OrderAmqpOptions) =>
  Module("Amqp")({
    provides: [Provider(OrderAmqpRuntime)({ value: orderAmqpRuntime(options) })],
    exports: [OrderAmqpRuntime],
  });

/**
 * A `Runtime` broadcasting the order application's facts over AMQP — both
 * halves of the outbox pattern in one process.
 *
 * The consuming half is `@btravstack/amqp`'s runtime, unchanged: the
 * `order-notifications` queue, a unit per delivery, the kernel's drain. The
 * publishing half is this example's own: `startOutboxRelay` is layered onto
 * the runtime the package hands back, started after it and stopped before it,
 * so a relay that cannot reach the broker fails startup the same way a
 * consumer that cannot would.
 *
 * `drain` is deliberately the consumer's alone. Draining means "stop taking
 * new work", and the relay's work is outbound — pending rows it has not
 * published yet are *safer* published during the drain window than abandoned
 * to the next boot. It stops at `stop`, before the consumer's transport goes.
 *
 * The contract is **imported, not a parameter**: this deployment implements
 * exactly one, and every caller would pass the same `orderContract` constant.
 * (`order-temporal-worker`'s runtime does take one, because its specs pass a
 * genuinely different value — `withTaskQueue(orderContract, …)` scopes each
 * test to its own task queue. Here the specs get their isolation from a
 * per-test vhost in the URL, so nothing varies and the parameter would be
 * ceremony.)
 */
export const orderAmqpRuntime = ({
  relay,
  ...transport
}: OrderAmqpOptions): Runtime<AmqpNeeds, AmqpInfo> => {
  const consumer = amqpRuntime({
    ...transport,
    contract: orderContract,
    needs: [Outbox, Logger],
    handlers: () => ({ orderChanged: notifyHandler(orderContract) }),
    middleware: (host) => messageUnits<AmqpNeeds>(host),
  });

  return {
    name: consumer.name,
    needs: consumer.needs,
    start: (host) =>
      consumer.start(host).flatMap((serving) =>
        startOutboxRelay(host.ctx, { urls: transport.urls, pollMs: relay.pollMs }).map(
          (running) => ({
            ...serving,
            stop: () => running.stop().flatMap(() => serving.stop()),
          }),
        ),
      ),
  };
};

/**
 * The consuming half's one handler — a subscriber like any other service
 * would write, reacting to a fact somebody else committed. It has no domain
 * errors to triage: notifying is a `Logger.info` here, and a real notifier's
 * failures would be retryable infrastructure, not answers about the order.
 *
 * The `payload === null` branch is the whole point of the envelope: one
 * handler, one stream, and a reader that keeps its own copy of a subject
 * upserts on a payload and drops on a tombstone. There is no second message
 * type to declare, subscribe to, or keep ordered against this one.
 */
const notifyHandler = (contract: OrderContract) =>
  declareHandler<OrderContract, "orderChanged", MessageUnitContext<AmqpNeeds>>(
    contract,
    "orderChanged",
    (message, _raw, { context }) => {
      const { id, payload } = message.payload;
      context.ctx
        .get(Logger)
        .info(
          payload === null
            ? `order ${id} is gone — notifying`
            : `order ${id} placed — notifying (${payload.quantity} items)`,
        );
      return OkAsync();
    },
  );
