import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { FulfillmentModule } from "./fulfillment.js";

/**
 * The composition root of the orchestration deployment. `ApplicationModule`
 * and `PersistenceModule` are booted here unchanged — the same pair every
 * other deployment composes — plus `FulfillmentModule`, the two external
 * services only this deployment orchestrates.
 *
 * The exports are the five ports the saga's activities resolve: the placement
 * use case, the repository (its `remove` is `cancelPlacement`'s persistence
 * arm), the two fulfillment services, and the logger. Declared here rather
 * than imported from a sibling because sharing a composition root would share
 * its transport dependency — one application, one root per process.
 */
export const OrderTemporalModule = Module("OrderTemporal")({
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule],
  exports: [PlaceOrder, OrderRepository, StockService, ShippingService, Logger],
});
