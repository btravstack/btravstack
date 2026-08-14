import { Config } from "@btravstack/config";
import { Module } from "@btravstack/di";
import {
  ApplicationModule,
  Logger,
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/start-example-order-application";
import { PersistenceModule } from "@btravstack/start-example-order-infrastructure";

import { probeConfig, temporalConfig } from "./config.js";
import { FulfillmentModule } from "./fulfillment.js";

/**
 * The composition root of the orchestration deployment. `ApplicationModule`
 * and `PersistenceModule` are booted here unchanged — the same pair every
 * other deployment composes — plus `FulfillmentModule`, the two external
 * services only this deployment orchestrates.
 *
 * The two configs are imported the same way, because that is all a config is:
 * a module providing a port. `Config.source(process.env)` is the one place the
 * environment enters the graph, so `Config.parse`'s pre-boot check and the
 * providers that inject the values cannot disagree about what it held. A spec
 * imports its own record instead (`src/test-fixtures.ts`).
 *
 * `probeConfig` is imported but not exported: nothing in the graph resolves
 * it, and it is here so `PROBE_PORT` is validated by the same pre-boot pass as
 * every other variable.
 *
 * The exports are the five ports the saga's activities resolve — the placement
 * use case, the repository (its `remove` is `cancelPlacement`'s persistence
 * arm), the two fulfillment services, and the logger — plus the config the
 * runtime reads its namespace from. Declared here rather than imported from a
 * sibling because sharing a composition root would share its transport
 * dependency — one application, one root per process.
 */
export const OrderTemporalModule = Module("OrderTemporal")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    FulfillmentModule,
    temporalConfig,
    probeConfig,
    Config.source(process.env),
  ],
  exports: [PlaceOrder, OrderRepository, StockService, ShippingService, Logger, temporalConfig],
});
