import { Module } from "@btravstack/di";

import { BillingModule } from "../../billing.js";
import { chargeOrder } from "./activities.js";

/**
 * The billing slice: a different vertical from fulfillment's, so a different
 * import list. `BillingModule` is the only import — `PlaceOrder` is as
 * invisible here as `PaymentService` is in the fulfillment slice, because
 * taking the money is not part of placing, reserving or shipping the order.
 *
 * `exports: [chargeOrder]` is the provider, not a port class:
 * `TemporalWorkflowActivities` mints the port from the contract key.
 */
export const BillingSlice = Module("BillingSlice")({
  imports: [BillingModule],
  provides: [chargeOrder],
  exports: [chargeOrder],
});
