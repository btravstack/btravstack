import { Module } from "@btravstack/di";

import { ordersController } from "./controller.js";

/** The orders slice: its controller, and nothing else the rest of the app can see. */
export const OrdersSlice = Module("OrdersSlice")({
  provides: [ordersController],
  exports: [ordersController.port],
});
