import { Module } from "@btravstack/di";
import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { customersController } from "./controller.js";

/**
 * The customers slice, on `OrdersSlice`'s shape exactly: its own vertical
 * imported here, its controller provided, and only that controller exported.
 * Importing the same two modules is not duplication — di dedupes by provider
 * reference, so the second import costs nothing and the slice stays readable
 * on its own.
 */
export const CustomersSlice = Module("CustomersSlice")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [customersController],
  exports: [customersController],
});
