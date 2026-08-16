import { Module } from "@btravstack/di";

import { FindOrder, PlaceOrder } from "./ports.js";
import { findOrderProvider, placeOrderProvider } from "./use-cases.js";

/**
 * `OrderRepository` and `Logger` are deliberately absent from `provides`: the
 * interactors depend on them and nothing here satisfies them, so di propagates
 * both as unmet needs. `Module.scoped(ApplicationModule, …)` therefore does not
 * compile — an importing module must provide a repository and a logger first.
 * That arity error is the layering, enforced by the compiler rather than by
 * convention.
 *
 * The logger is `@btravstack/observability`'s port, not one this layer
 * declares: a composition root imports `observability()` and the lines this
 * layer writes come out correlated with whatever unit the runtime opened.
 * There is nothing to provide here and nothing to re-export — the port belongs
 * to the framework, exactly like `OrderRepository` belongs to this layer.
 */
export const ApplicationModule = Module("Application")({
  provides: [placeOrderProvider, findOrderProvider],
  exports: [PlaceOrder, FindOrder],
});
