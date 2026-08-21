import { Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger } from "@btravstack/observability";

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
  // The environment its persistence reads `DATABASE_URL` from, and the logger
  // the interactors and the stand-in services write to. Both come from the
  // root; neither is this slice's to provide.
  needs: [Env, Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule, FulfillmentModule],
  provides: [fulfillOrder],
  exports: [fulfillOrder],
});
