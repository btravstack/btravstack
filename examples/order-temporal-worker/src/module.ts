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
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";

import { FulfillmentModule } from "./fulfillment.js";
import { OrderTemporalRuntime, temporalModule } from "./temporal-runtime.js";

/**
 * The composition root of the orchestration deployment. `ApplicationModule`
 * and `PersistenceModule` are booted here unchanged — the same pair every
 * other deployment composes — plus `FulfillmentModule`, the two external
 * services only this deployment orchestrates, and the runtime itself, which
 * is a service the graph provides rather than an option handed to `start`.
 *
 * A constant: everything the process used to pass in — the connection, its
 * namespace — is now bound from the environment inside `temporalModule`, and
 * where the workflow code lives is a static fact of this deployment.
 * `workflowsPathFromURL` points Temporal at the workflow module so it can
 * bundle it for the sandbox; a spec hands over a prebuilt bundle instead,
 * which is why `WorkflowSource` has two arms.
 *
 * The exports are the runtime's port plus the five ports the saga's activities
 * resolve: the placement use case, the repository (its `remove` is
 * `cancelPlacement`'s persistence arm), the two fulfillment services, and the
 * logger. `start`'s gate reads both halves off these exports. Declared here
 * rather than imported from a sibling because sharing a composition root would
 * share its transport dependency — one application, one root per process.
 */
export const OrderTemporalWorker = Module("OrderTemporalWorker")({
  imports: [
    ApplicationModule,
    PersistenceModule,
    FulfillmentModule,
    temporalModule({
      contract: orderContract,
      workflows: { workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js") },
    }),
  ],
  exports: [
    OrderTemporalRuntime,
    PlaceOrder,
    OrderRepository,
    StockService,
    ShippingService,
    Logger,
  ],
});
