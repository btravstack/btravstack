import { Module } from "@btravstack/di";
import { OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { Logger } from "@btravstack/observability";

import { piece } from "./controller.js";

/**
 * The orders slice: everything it takes to serve `contract.orders`, and
 * nothing else the rest of the app can see.
 *
 * It imports its own vertical rather than leaving `PlaceOrder` and `FindOrder`
 * as needs for the root to discharge. That is what makes it a slice: the
 * reason to open this directory is the whole reason the slice exists, and the
 * root below is a list of slices instead of a list of everything every slice
 * happens to need. The two modules it imports are the orders vertical's own
 * halves — `FindCustomer` and the customer repository are not in this graph at
 * all, which is what the split bought over importing the layer whole.
 *
 * The two slices still meet, one level down: both persistence modules import
 * the same database module, and di flattens the tree with a `Set` keyed by
 * provider **reference**, so the diamond yields one connection, not two.
 *
 * `exports: [piece]` is the provider, not `piece.port`: `HttpController`
 * mints the port for you, so there is no class to name.
 */
export const slice = Module("OrdersSlice")({
  // The controller writes a line itself, so `Logger` is this slice's own
  // provider's need. The environment its persistence reads is not: that is
  // `DatabaseModule`'s, declared there and inherited here.
  needs: [Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [piece],
  exports: [piece],
});
