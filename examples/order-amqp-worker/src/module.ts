import { AmqpRuntime, amqp } from "@btravstack/amqp";
import { Module } from "@btravstack/di";
import { orderContract } from "@btravstack/example-order-amqp-contract";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { OrderHandlers, orderHandlers } from "./handlers.js";
import { outboxRelay, relayConfig } from "./outbox-relay.js";

/**
 * The composition root of the broadcast deployment. `ApplicationModule` and
 * `PersistenceModule` are booted here unchanged — the same pair every other
 * deployment composes — with `@btravstack/amqp`'s starter providing the
 * runtime over the handlers this deployment provides, and the outbox relay
 * as a resourceful provider next to it: both halves of the outbox pattern in
 * one graph, each built by di from the services it declares.
 *
 * `amqp()` needs `OrderHandlers`, which is provided here — di's own gate
 * checks that where this module is declared. The exports are this
 * deployment's own selection: `AmqpRuntime` is what `start` resolves, and
 * `PlaceOrder` / `OrderRepository` / `Outbox` / `Logger` are the writer's
 * surface — what a writer in the same process (the specs; in production,
 * `order-api` against the same database) places and cancels orders through,
 * and what the specs tap. Both write paths leave the outbox an event, which is
 * the property this deployment exists to demonstrate.
 *
 * A constant: the broker URL and the relay's poll interval are read from the
 * environment inside the graph (`AmqpConfig` from `AMQP_URL`, `RelayConfig`
 * from `OUTBOX_POLL_MS`), so nothing has to be passed in — `main.ts` boots
 * this value as is, and the specs boot it with `env` pointing at each test's
 * own vhost.
 */
export const OrderAmqpWorker = Module("OrderAmqpWorker")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    amqp({ contract: orderContract, handlers: OrderHandlers }),
  ],
  provides: [orderHandlers, relayConfig, outboxRelay],
  exports: [AmqpRuntime, PlaceOrder, OrderRepository, Outbox, Logger],
});
