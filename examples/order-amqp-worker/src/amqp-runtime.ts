import { declareHandler } from "@amqp-contract/worker";
import {
  amqpRuntime,
  messageUnits,
  type AmqpInfo,
  type MessageUnitContext,
} from "@btravstack/start-amqp";
import type { Runtime } from "@btravstack/start-core";
import { orderContract, type OrderContract } from "@btravstack/start-example-order-amqp-contract";
import { Logger, Outbox } from "@btravstack/start-example-order-application";
import { OkAsync } from "unthrown";

import { amqpConfig } from "./config.js";
import { outboxRelayConfig, startOutboxRelay } from "./outbox-relay.js";

/**
 * The ports this runtime resolves out of the application context: `Outbox`
 * for the relay half, `Logger` for both halves, and the two configs that say
 * which broker to reach and how often to sweep. `PlaceOrder` is deliberately
 * absent — nothing on a broadcast consumes a command, and a runtime declares
 * what *it* needs rather than what the module happens to export.
 *
 * A config is a need like any other port, which is the point: `start` proves
 * at the call site that the graph carries them, so a deployment that forgot to
 * import `amqpConfig` fails to compile rather than to boot.
 *
 * One array, two uses — the union below is read off it, so the declared needs
 * and the type the handlers see cannot drift apart.
 *
 * Non-empty on purpose: it is what makes `start`'s arity gate mean something
 * (`src/needs-gate.test-d.ts` pins both directions).
 */
const amqpNeeds = [Outbox, Logger, amqpConfig, outboxRelayConfig] as const;

type AmqpNeeds = (typeof amqpNeeds)[number];

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
 *
 * It takes **no arguments at all**, which is the point worth copying. The
 * broker URL and the relay's sweep interval used to be parameters, threaded in
 * from `main.ts` after it had read the environment. They are configuration,
 * and a runtime is handed a `Context` at `start` — so it reads them itself,
 * out of the same graph everything else comes from. `main.ts` no longer knows
 * what a broker URL is, and a spec swaps the broker by swapping a module.
 *
 * The contract is **imported, not a parameter**, for the same kind of reason
 * turned the other way: this deployment implements exactly one, and every
 * caller would pass the same `orderContract` constant.
 * (`order-temporal-worker`'s runtime does take one, because its specs pass a
 * genuinely different value — `withTaskQueue(orderContract, …)` scopes each
 * test to its own task queue. Here the specs get their isolation from a
 * per-test vhost in the URL, which is now a config value, so nothing varies
 * and the parameter would be ceremony.)
 */
export const orderAmqpRuntime = (): Runtime<AmqpNeeds, AmqpInfo> => ({
  // Stated here rather than forwarded from the consumer, because the consumer
  // does not exist yet: its broker URL is configuration, and configuration is
  // only readable once the graph has been built and handed this runtime a
  // context — which is exactly what `name` and `needs` must be answerable
  // *before*. `"amqp"` is `@btravstack/start-amqp`'s own name for itself.
  name: "amqp",
  needs: amqpNeeds,
  start: (host) => {
    const consumer = amqpRuntime({
      urls: [host.ctx.get(amqpConfig).url],
      contract: orderContract,
      needs: amqpNeeds,
      handlers: () => ({ orderChanged: notifyHandler(orderContract) }),
      middleware: (h) => messageUnits<AmqpNeeds>(h),
    });

    return consumer.start(host).flatMap((serving) =>
      startOutboxRelay(host.ctx).map((running) => ({
        ...serving,
        stop: () => running.stop().flatMap(() => serving.stop()),
      })),
    );
  },
});

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
