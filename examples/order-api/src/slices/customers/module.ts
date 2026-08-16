import { Module } from "@btravstack/di";

import { customersController } from "./controller.js";
import { customerDirectory } from "./directory.js";

/** The customers slice: its adapter is private, only its controller is exported. */
export const CustomersSlice = Module("CustomersSlice")({
  provides: [customerDirectory, customersController],
  exports: [customersController.port],
});
