import { Module } from "@btravstack/di";

import { FindCustomer, FindOrder, PlaceOrder } from "./ports.js";
import { findCustomerProvider, findOrderProvider, placeOrderProvider } from "./use-cases.js";

/**
 * `OrderRepository`, `CustomerRepository` and `Logger` are deliberately absent
 * from `provides`: the interactors depend on them and nothing here satisfies
 * them, so di propagates all three as unmet needs.
 * `Module.scoped(ApplicationModule, …)` therefore does not compile — an
 * importing module must provide the repositories and a logger first. That
 * arity error is the layering, enforced by the compiler rather than by
 * convention, and it holds per port: adding the customers vertical added a
 * need, not an exception.
 *
 * The logger is `@btravstack/observability`'s port, not one this layer
 * declares: a composition root imports `observability()` and the lines this
 * layer writes come out correlated with whatever unit the runtime opened.
 * There is nothing to provide here and nothing to re-export — the port belongs
 * to the framework, exactly like the repositories belong to this layer.
 */
export const ApplicationModule = Module("Application")({
  provides: [placeOrderProvider, findOrderProvider, findCustomerProvider],
  exports: [PlaceOrder, FindOrder, FindCustomer],
});
