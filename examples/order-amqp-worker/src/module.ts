import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { OrderAmqpRuntime, amqpModule } from "./amqp-runtime.js";

/**
 * The composition root of the broadcast deployment. `ApplicationModule` and
 * `PersistenceModule` are booted here unchanged — the same pair every other
 * deployment composes — with `amqpModule` providing the runtime that relays
 * the outbox onto a broker and consumes the broadcast back.
 *
 * The exports are this deployment's own selection: `OrderAmqpRuntime` is what
 * `start` resolves, `Outbox` and `Logger` are what that runtime needs, and
 * `PlaceOrder` / `OrderRepository` are the writer's surface — what a writer in
 * the same process (the specs; in production, `order-api` against the same
 * database) places and cancels orders through. Both write paths leave the
 * outbox an event, which is the property this deployment exists to
 * demonstrate. Declared here rather than imported from a sibling because
 * sharing a composition root would share its transport dependency — one
 * application, one root per process.
 *
 * A constant: the broker URL and the relay's poll interval are read from the
 * environment inside the graph (`amqpModule`'s `AmqpConfig`), so nothing has
 * to be passed in — `main.ts` boots this value as is, and the specs boot it
 * with `env` pointing at each test's own vhost.
 */
export const OrderAmqpWorker = Module("OrderAmqpWorker")({
  imports: [ApplicationModule, PersistenceModule, amqpModule],
  exports: [OrderAmqpRuntime, PlaceOrder, OrderRepository, Outbox, Logger],
});
