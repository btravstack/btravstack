import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";

import { ordersController } from "./controller.js";
import { orderRowFragment } from "./fragment.js";

/**
 * The orders slice: everything it takes to serve `contract.orders`, and
 * nothing else the rest of the app can see.
 *
 * It imports no vertical, and that is the tenancy showing through: the use
 * cases its controller and fragment read are built per REQUEST, in the `user`
 * kind's module, over the tenant that request authenticated as. What a slice
 * owns is its piece of the surface and its triage; what a unit owns is the
 * graph a request runs against.
 *
 * `exports: [ordersController, orderRowFragment]` are the providers, not their
 * `.port`s: `OrpcController` and `HtmxGet` each mint the port for you,
 * so there is no class to name.
 */
export const OrdersSlice = Module("OrdersSlice")({
  // The controller writes a line itself, so `Logger` is this slice's own
  // provider's need. The use cases are not: they reach a leaf off
  // `context.unit`, never through `inject`.
  needs: [Logger],
  provides: [ordersController, orderRowFragment],
  exports: [ordersController, orderRowFragment],
});
