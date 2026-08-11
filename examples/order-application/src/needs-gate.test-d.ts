/**
 * The compile-time half of the layering: `ApplicationModule` declares
 * `OrderRepository` as an unmet need, so di's phantom rest-tuple gate makes
 * scoping it a call-site arity error until an outer module provides one.
 * Type-checked by this package's `test:types` script, never executed.
 */
import { Module, Provider } from "@btravstack/di";
import { DuplicateOrder, OrderNotFound, type Order } from "@btravstack/start-example-order-domain";
import { Err, Ok } from "unthrown";

import { ApplicationModule, FindOrder, Logger, OrderRepository, PlaceOrder } from "./index.js";

// Negative: nothing provides `OrderRepository`, so the gate becomes a required
// two-element tuple and the call is an arity error naming the unmet need.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: no OrderRepository is provided.
const _unwired = Module.scoped(ApplicationModule, (ctx) => ctx.get(PlaceOrder).execute("o-1", 1));

const Wired = Module("Wired")({
  imports: [ApplicationModule],
  provides: [
    Provider(OrderRepository)({
      value: {
        save: (order: Order) => Err(new DuplicateOrder({ id: order.id })).toAsync(),
        find: (id: string) => Err(new OrderNotFound({ id })).toAsync(),
      },
    }),
  ],
  exports: [PlaceOrder, FindOrder, Logger],
});

// Positive: with a repository in scope the need is discharged, and this is an
// ordinary two-argument call.
const _wired = Module.scoped(Wired, (ctx) => ctx.get(FindOrder).execute("o-1"));
