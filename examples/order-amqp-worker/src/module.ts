import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  Logger,
  Outbox,
  PlaceOrder,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

/**
 * The composition root of the broadcast deployment. `ApplicationModule` and
 * `PersistenceModule` are booted here unchanged — the same pair every other
 * deployment composes — under a runtime that relays the outbox onto a broker
 * and consumes the broadcast back.
 *
 * The exports are this deployment's own selection: `Outbox` and `Logger` are
 * what the runtime needs, `PlaceOrder` is what a writer in the same process
 * (the specs; in production, `order-api` against the same database) places
 * orders through. Declared here rather than imported from a sibling because
 * sharing a composition root would share its transport dependency — one
 * application, one root per process.
 */
export const OrderAmqpModule = Module("OrderAmqp")({
  imports: [ApplicationModule, PersistenceModule],
  exports: [PlaceOrder, Outbox, Logger],
});
