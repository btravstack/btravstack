import { Module } from "@btravstack/di";

import { loggerProvider } from "./logger.js";
import { FindOrder, Logger, PlaceOrder } from "./ports.js";
import { findOrderProvider, placeOrderProvider } from "./use-cases.js";

/**
 * `OrderRepository` is deliberately absent from `provides`: both interactors
 * depend on it and nothing here satisfies it, so di propagates it as an unmet
 * need. `Module.scoped(ApplicationModule, …)` therefore does not compile — an
 * importing module must provide a repository first. That arity error is the
 * layering, enforced by the compiler rather than by convention.
 */
export const ApplicationModule = Module("Application")({
  provides: [loggerProvider, placeOrderProvider, findOrderProvider],
  exports: [PlaceOrder, FindOrder, Logger],
});
