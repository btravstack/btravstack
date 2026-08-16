import { AmqpModule } from "@btravstack/amqp";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  ApplicationModule,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger, observability } from "@btravstack/observability";

import { orderHandlers } from "./handlers.js";
import { outboxRelay, relayConfig } from "./outbox-relay.js";

/**
 * The composition root of the broadcast deployment. `ApplicationModule` and
 * `PersistenceModule` are booted here unchanged — the same pair every other
 * deployment composes — through `@btravstack/amqp`'s `AmqpModule` sugar,
 * which imports the starter over `orderHandlers`, provides it, and exports
 * `AmqpRuntime` for `start` to resolve; the outbox relay sits next to it as a
 * resourceful provider: both halves of the outbox pattern in one graph, each
 * built by di from the services it declares. `observability()` provides the
 * `Logger` the consumer and the relay write to — `LOG_LEVEL`, JSON on stdout,
 * every line correlated with the delivery's own unit.
 *
 * The exports are this deployment's own selection: `PlaceOrder` /
 * `OrderRepository` / `Outbox` / `Logger` are the writer's surface — what a
 * writer in the same process (the specs; in production, `order-api` against
 * the same database) places and cancels orders through, and what the specs
 * tap. Both write paths leave the outbox an event, which is the property this
 * deployment exists to demonstrate.
 *
 * A constant: the broker URL and the relay's poll interval are read from the
 * environment inside the graph (`AmqpConfig` from `AMQP_URL`, `RelayConfig`
 * from `OUTBOX_POLL_MS`), so nothing has to be passed in — `main.ts` boots
 * this value as is, and the specs boot it with `env` pointing at each test's
 * own vhost.
 */
export const OrderAmqpWorker = AmqpModule("OrderAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [ApplicationModule, PersistenceModule, observability()],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
