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
import {
  OrderTemporalRuntime,
  temporalModule,
  type TemporalWorkerOptions,
} from "./temporal-runtime.js";

/**
 * The composition root of the orchestration deployment. `ApplicationModule`
 * and `PersistenceModule` are booted here unchanged — the same pair every
 * other deployment composes — plus `FulfillmentModule`, the two external
 * services only this deployment orchestrates, and the runtime itself, which
 * is a service the graph provides rather than an option handed to `start`.
 *
 * A function rather than a constant because the runtime is built from what
 * only the process knows — the connection it opened, its namespace, where the
 * workflow code lives — and a spec hands over the test environment's instead.
 *
 * The exports are the runtime's port plus the five ports the saga's activities
 * resolve: the placement use case, the repository (its `remove` is
 * `cancelPlacement`'s persistence arm), the two fulfillment services, and the
 * logger. `start`'s gate reads both halves off these exports. Declared here
 * rather than imported from a sibling because sharing a composition root would
 * share its transport dependency — one application, one root per process.
 */
export const orderTemporalWorker = (options: TemporalWorkerOptions) =>
  Module("OrderTemporalWorker")({
    imports: [ApplicationModule, PersistenceModule, FulfillmentModule, temporalModule(options)],
    exports: [
      OrderTemporalRuntime,
      PlaceOrder,
      OrderRepository,
      StockService,
      ShippingService,
      Logger,
    ],
  });
