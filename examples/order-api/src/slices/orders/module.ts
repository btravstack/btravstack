import { Module } from "@btravstack/di";
import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";

import { ordersController } from "./controller.js";

/**
 * The orders slice: everything it takes to serve `contract.orders`, and
 * nothing else the rest of the app can see.
 *
 * It imports its own vertical rather than leaving `PlaceOrder` and `FindOrder`
 * as needs for the root to discharge. That is what makes it a slice: the
 * reason to open this directory is the whole reason the slice exists, and the
 * root below is a list of slices instead of a list of everything every slice
 * happens to need. Both slices import `PersistenceModule`, and di flattens the
 * tree with a `Set` keyed by provider **reference**, so the diamond yields one
 * database, not two.
 *
 * `exports: [ordersController]` is the provider, not `ordersController.port`:
 * `HttpController` mints the port for you, so there is no class to name.
 */
export const OrdersSlice = Module("OrdersSlice")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [ordersController],
  exports: [ordersController],
});
