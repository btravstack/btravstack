import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";

import {
  CustomerRepository,
  FindCustomer,
  FindOrder,
  ListOrders,
  OrderRepository,
  PlaceOrder,
} from "./ports.js";
import {
  findCustomerProvider,
  findOrderProvider,
  listOrdersProvider,
  placeOrderProvider,
} from "./use-cases.js";

/**
 * One module per vertical, not one for the layer. A deployment that only
 * places and reads orders — both workers — imports `OrderApplicationModule`
 * and never learns that customers exist; the API's two slices take one each.
 * The layer is a package, the module is a slice of it, and the difference is
 * what a consumer is made to depend on.
 *
 * `OrderRepository` and `Logger` are `needs`, not `provides`: the interactors
 * depend on them and nothing here satisfies them, so
 * `Module.scoped(OrderApplicationModule, …)` does not compile — an importing
 * module must provide them first. That refusal is the layering, enforced by the
 * compiler rather than by convention, and the split sharpened it: each
 * vertical's gate carries that vertical's own repository, so a graph cannot
 * close the orders half with a customers adapter.
 *
 * The logger is the framework's port, not one this layer declares: a root
 * imports `observability()` and the lines this layer writes come out correlated
 * with whatever unit the runtime opened.
 */
export const OrderApplicationModule = Module("OrderApplication")({
  needs: [OrderRepository, Logger],
  provides: [placeOrderProvider, findOrderProvider, listOrdersProvider],
  exports: [PlaceOrder, FindOrder, ListOrders],
});

/**
 * The customers vertical, on the same terms and with a shorter list of needs:
 * no logger, because only `PlaceOrder` writes a line. That asymmetry is the
 * split earning its keep — one module for the layer had to owe every port any
 * of its use cases owed. Neither vertical imports the other; a dependency
 * between them would be the layer growing an inside.
 */
export const CustomerApplicationModule = Module("CustomerApplication")({
  needs: [CustomerRepository],
  provides: [findCustomerProvider],
  exports: [FindCustomer],
});
