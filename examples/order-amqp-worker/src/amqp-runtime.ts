import { declareHandler } from "@amqp-contract/worker";
import {
  amqpRuntime,
  messageUnits,
  type AmqpInfo,
  type MessageUnitContext,
} from "@btravstack/start-amqp";
import type { Runtime } from "@btravstack/start-core";
import type { OrderContract } from "@btravstack/start-example-order-amqp-contract";
import { Logger, Outbox } from "@btravstack/start-example-order-application";
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
 * A `Runtime` broadcasting the order application's facts over AMQP — both
 * halves of the outbox pattern in one process.
 *
 * The consuming half is `@btravstack/start-amqp`'s runtime, unchanged: the
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
 */
export const orderAmqpRuntime = ({
  contract,
  relay,
  ...transport
}: {
  /** The contract: the exchange the relay publishes to, the queue this worker consumes. */
  readonly contract: OrderContract;
  /** The broker URLs `TypedAmqpWorker` connects to — it owns the connection. */
  readonly urls: readonly string[];
  /** The relay's own knobs; its client shares the broker but not the connection. */
  readonly relay: Pick<RelayOptions, "pollMs">;
}): Runtime<AmqpNeeds, AmqpInfo> => {
  const consumer = amqpRuntime({
    ...transport,
    contract,
    needs: [Outbox, Logger],
    handlers: () => ({ orderPlaced: notifyHandler(contract) }),
    middleware: (host) => messageUnits<AmqpNeeds>(host),
  });

  return {
    name: consumer.name,
    needs: consumer.needs,
    start: (host) =>
      consumer.start(host).flatMap((serving) =>
        startOutboxRelay(host.ctx, contract, { urls: transport.urls, pollMs: relay.pollMs }).map(
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
 */
const notifyHandler = (contract: OrderContract) =>
  declareHandler<OrderContract, "orderPlaced", MessageUnitContext<AmqpNeeds>>(
    contract,
    "orderPlaced",
    (message, _raw, { context }) => {
      context.ctx
        .get(Logger)
        .info(
          `order ${message.payload.orderId} placed — notifying (${message.payload.quantity} items)`,
        );
      return OkAsync();
    },
  );
