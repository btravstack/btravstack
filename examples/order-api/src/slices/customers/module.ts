import { Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { CustomerApplicationModule } from "@btravstack/example-order-application";
import { CustomerPersistenceModule } from "@btravstack/example-order-infrastructure";

import { customersController } from "./controller.js";

/**
 * The customers slice, on `OrdersSlice`'s shape exactly: its own vertical
 * imported here, its controller provided, and only that controller exported.
 * A different vertical, so a different pair of modules — the slice boundary
 * reaches all the way down to the adapter, and `PlaceOrder` is as invisible
 * here as `FindCustomer` is over there.
 *
 * What the two slices do share is the connection underneath both persistence
 * modules: one provider reference, so one database.
 */
export const CustomersSlice = Module("CustomersSlice")({
  // Shorter than the orders slice's by one: `FindCustomer` writes no line, so
  // this slice owes the environment and not the logger.
  needs: [Env],
  imports: [CustomerApplicationModule, CustomerPersistenceModule],
  provides: [customersController],
  exports: [customersController],
});
