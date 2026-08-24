import { Module } from "@btravstack/di";
import { CustomerApplicationModule } from "@btravstack/example-order-application";
import { CustomerPersistenceModule } from "@btravstack/example-order-infrastructure";

import { piece } from "./controller.js";

/**
 * The customers slice, on the orders slice's shape exactly: its own vertical
 * imported here, its controller provided, and only that controller exported.
 * A different vertical, so a different pair of modules — the slice boundary
 * reaches all the way down to the adapter, and `PlaceOrder` is as invisible
 * here as `FindCustomer` is over there.
 *
 * What the two slices do share is the connection underneath both persistence
 * modules: one provider reference, so one database.
 */
export const slice = Module("CustomersSlice")({
  imports: [CustomerApplicationModule, CustomerPersistenceModule],
  provides: [piece],
  exports: [piece],
});
