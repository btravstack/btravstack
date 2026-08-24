import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";

import {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  OrderRepository,
  PlaceOrder,
} from "./ports.js";
import { findCustomerProvider, findOrderProvider, placeOrderProvider } from "./use-cases.js";

/**
 * One module per vertical, not one for the layer. A deployment that only
 * places and reads orders — both workers — imports `OrderApplicationModule`
 * and never learns that customers exist; the API's two slices take one each.
 * The layer is a package, the module is a slice of it, and the difference is
 * what a consumer is made to depend on.
 *
 * `OrderRepository` and `Logger` are `needs`, not `provides`: the interactors
 * depend on them, nothing here satisfies them, and this layer says so out loud
 * rather than letting a composition root happen to hold them.
 * `Module.scoped(OrderApplicationModule, …)` therefore
 * does not compile — an importing module must provide the repository and a
 * logger first. That refusal is the layering, enforced by the compiler
 * rather than by convention, and splitting the module sharpened it: each
 * vertical's gate now carries that vertical's own repository, so a graph
 * cannot close the orders half with a customers adapter — and prints it: the
 * diagnostic ends on `"UNSATISFIED DEPENDENCIES — nothing provides":
 * Logger | OrderRepository` (di's `DependencyGate`, the marker that replaced
 * the mute rest-tuple arity error).
 *
 * The logger is `@btravstack/observability`'s port, not one this layer
 * declares: a composition root imports `observability()` and the lines this
 * layer writes come out correlated with whatever unit the runtime opened.
 * There is nothing to provide here and nothing to re-export — the port belongs
 * to the framework, exactly like the repositories belong to this layer.
 */
export const OrderApplicationModule = Module("OrderApplication")({
  needs: [OrderRepository, Logger],
  provides: [placeOrderProvider, findOrderProvider],
  exports: [PlaceOrder, FindOrder],
});

/**
 * The customers vertical, on the same terms — and with a shorter list of
 * needs: `CustomerRepository`, and not the logger, because only
 * `PlaceOrder` writes a line. That asymmetry is the split earning its keep;
 * one module for the layer had to owe every port any of its use cases owed.
 * Nothing here imports `OrderApplicationModule`, and nothing there imports
 * this — two verticals of one layer are siblings, and a dependency between
 * them would be the layer growing an inside.
 */
export const CustomerApplicationModule = Module("CustomerApplication")({
  needs: [CustomerRepository],
  provides: [findCustomerProvider],
  exports: [FindCustomer],
});
