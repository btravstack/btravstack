import { Module } from "@btravstack/di";
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";

import { FulfillmentModule } from "../../fulfillment.js";
import { fulfillOrder } from "./activities.js";

/**
 * The fulfillment slice: the saga, its activities, and the vertical they run
 * on — the orders vertical exactly as `order-api`'s own slice imports it, plus
 * the two external services only this saga orchestrates. Nothing billing owns
 * is in this graph.
 *
 * `exports: [fulfillOrder]` is the provider, not a port class:
 * `TemporalWorkflowActivities` mints the port from the contract key.
 */
export const FulfillmentSlice = Module("FulfillmentSlice")({
  imports: [OrderApplicationModule, OrderPersistenceModule, FulfillmentModule],
  provides: [fulfillOrder],
  exports: [fulfillOrder],
});
