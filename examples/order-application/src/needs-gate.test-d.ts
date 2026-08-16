/**
 * The compile-time half of the layering: `ApplicationModule` declares
 * `OrderRepository` and `Logger` as unmet needs, so di's phantom rest-tuple
 * gate makes scoping it a call-site arity error until an outer module provides
 * them. Type-checked by this package's `test:types` script, never executed.
 */
import { Module, Provider } from "@btravstack/di";
import { DuplicateOrder, OrderNotFound, type Order } from "@btravstack/example-order-domain";
import { Logger, createLogger } from "@btravstack/observability";
import { ErrAsync } from "unthrown";

import { ApplicationModule, FindOrder, OrderRepository, PlaceOrder } from "./index.js";

// Negative: nothing provides `OrderRepository`, so the gate becomes a required
// two-element tuple and the call is an arity error naming the unmet need.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: no OrderRepository is provided.
const _unwired = Module.scoped(ApplicationModule, (ctx) => ctx.get(PlaceOrder).execute("o-1", 1));

const Wired = Module("Wired")({
  imports: [ApplicationModule],
  provides: [
    Provider(OrderRepository)({
      value: {
        save: (order: Order) => ErrAsync(new DuplicateOrder({ id: order.id })),
        find: (id: string) => ErrAsync(new OrderNotFound({ id })),
        remove: (id: string) => ErrAsync(new OrderNotFound({ id })),
      },
    }),
    // The logger without the starter: `observability()` is the default, not
    // the only way — an application that wants its own provides `Logger`
    // itself, and nothing else in the graph can tell.
    Provider(Logger)({ value: createLogger(() => {}) }),
  ],
  exports: [PlaceOrder, FindOrder],
});

// Positive: with a repository and a logger in scope both needs are discharged,
// and this is an ordinary two-argument call.
const _wired = Module.scoped(Wired, (ctx) => ctx.get(FindOrder).execute("o-1"));
