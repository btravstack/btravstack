import { Module } from "@btravstack/di";

import { customersController } from "./controller.js";

/** The customers slice: its controller, and nothing else the rest of the app can see. */
export const CustomersSlice = Module("CustomersSlice")({
  provides: [customersController],
  exports: [customersController.port],
});
