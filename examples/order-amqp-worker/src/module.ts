import { Config } from "@btravstack/config";
import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  Outbox,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { amqpConfig, probeConfig } from "./config.js";
import { outboxRelayConfig } from "./outbox-relay.js";

/**
 * The composition root of the broadcast deployment. `ApplicationModule` and
 * `PersistenceModule` are booted here unchanged — the same pair every other
 * deployment composes — under a runtime that relays the outbox onto a broker
 * and consumes the broadcast back.
 *
 * The three configs are imported like any other module, and
 * `Config.source(process.env)` is the one place the environment enters the
 * graph: a config never reads `process.env` itself, so `Config.parse`'s
 * pre-boot check and the providers that inject the values cannot disagree
 * about what the environment was. A spec imports its own record instead
 * (`src/test-fixtures.ts`), and nothing below it can tell the difference.
 *
 * `probeConfig` is imported but not exported: nothing in the graph resolves
 * it, and it is here so that `PROBE_PORT` is validated by the same pre-boot
 * pass as every other variable.
 *
 * The exports are this deployment's own selection: `Outbox`, `Logger` and the
 * two configs are what the runtime needs, and `PlaceOrder` / `OrderRepository`
 * are the writer's surface — what a writer in the same process (the specs; in
 * production, `order-api` against the same database) places and cancels orders
 * through. Both write paths leave the outbox an event, which is the property
 * this deployment exists to demonstrate. Declared here rather than imported
 * from a sibling because sharing a composition root would share its transport
 * dependency — one application, one root per process.
 */
export const OrderAmqpModule = Module("OrderAmqp")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    amqpConfig,
    outboxRelayConfig,
    probeConfig,
    Config.source(process.env),
  ],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger, amqpConfig, outboxRelayConfig],
});
