import { Module } from "@btravstack/di";

import { FulfillmentModule } from "../../fulfillment.js";
import { fulfillOrder } from "./activities.js";

/**
 * The fulfillment slice: the saga, its activities, and the two external
 * services only this saga orchestrates. Nothing billing owns is in this graph,
 * and neither is the orders vertical: its use cases are built per ATTEMPT, in
 * `ActivityUnitModule`, over the tenant the attempt's input names.
 *
 * The saga also stores a confirmation once shipping is arranged, so its
 * activities inject `Storage` and the slice owes it to the root, which decides
 * which store that is and whether it is instrumented.
 *
 * `exports: [fulfillOrder]` is the provider, not a port class:
 * `TemporalWorkflowActivities` mints the port from the contract key.
 */
export const FulfillmentSlice = Module("FulfillmentSlice")({
  imports: [FulfillmentModule],
  provides: [fulfillOrder],
  exports: [fulfillOrder],
});
