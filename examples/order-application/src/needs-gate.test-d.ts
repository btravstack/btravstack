/**
 * The compile-time half of the layering, once per vertical:
 * `OrderApplicationModule` declares `OrderRepository` and `Logger` as unmet
 * needs and `CustomerApplicationModule` declares `CustomerRepository`, so di's
 * phantom rest-tuple gate makes scoping either one a call-site arity error
 * until an outer module provides them. Two gates rather than one, which is the
 * point of the split: closing the orders half says nothing about the customers
 * half, and the compiler says so at each module rather than once for the
 * layer. Type-checked by this package's `test:types` script, never executed.
 */
import { Module, Provider } from "@btravstack/di";
import {
  CustomerNotFound,
  DuplicateOrder,
  OrderNotFound,
  type Order,
} from "@btravstack/example-order-domain";
import { Logger, createLogger } from "@btravstack/observability";
import { ErrAsync } from "unthrown";

import {
  CustomerApplicationModule,
  CustomerRepository,
  FindCustomer,
  FindOrder,
  OrderApplicationModule,
  OrderRepository,
  PlaceOrder,
} from "./index.js";

const orderRepository = Provider(OrderRepository)({
  value: {
    save: (order: Order) => ErrAsync(new DuplicateOrder({ id: order.id })),
    find: (id: string) => ErrAsync(new OrderNotFound({ id })),
    remove: (id: string) => ErrAsync(new OrderNotFound({ id })),
  },
});

const customerRepository = Provider(CustomerRepository)({
  value: { find: (id: string) => ErrAsync(new CustomerNotFound({ id })) },
});

const logger = Provider(Logger)({ value: createLogger(() => {}) });

// Negative: nothing provides `OrderRepository`, so the gate becomes a required
// two-element tuple and the call is an arity error naming the unmet need.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: no OrderRepository is provided.
const _unwiredOrders = Module.scoped(OrderApplicationModule, (ctx) =>
  ctx.get(PlaceOrder).execute("o-1", 1),
);

// Negative, the same gate on the sibling module and a different port: the
// customers vertical owes its own repository and nothing else — not the
// logger, which only `PlaceOrder` writes to.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: no CustomerRepository is provided.
const _unwiredCustomers = Module.scoped(CustomerApplicationModule, (ctx) =>
  ctx.get(FindCustomer).execute("c-1"),
);

// Negative, per vertical: the orders repository closes the orders module, and
// says nothing about the customers one — a graph that wires the wrong
// vertical's adapter is still rejected.
const MiswiredCustomers = Module("MiswiredCustomers")({
  imports: [CustomerApplicationModule],
  provides: [orderRepository, logger],
  exports: [FindCustomer],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: no CustomerRepository is provided.
const _miswired = Module.scoped(MiswiredCustomers, (ctx) => ctx.get(FindCustomer).execute("c-1"));

// Negative, the other port of the orders pair: the repository alone does not
// close the module, because `PlaceOrder` writes a line.
const LoglessOrders = Module("LoglessOrders")({
  imports: [OrderApplicationModule],
  provides: [orderRepository],
  exports: [PlaceOrder, FindOrder],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: no Logger is provided.
const _logless = Module.scoped(LoglessOrders, (ctx) => ctx.get(FindOrder).execute("o-1"));

const WiredOrders = Module("WiredOrders")({
  imports: [OrderApplicationModule],
  provides: [
    orderRepository,
    // The logger without the starter: `observability()` is the default, not
    // the only way — an application that wants its own provides `Logger`
    // itself, and nothing else in the graph can tell.
    logger,
  ],
  exports: [PlaceOrder, FindOrder],
});

// Positive: the repository and a logger discharge every need the orders
// vertical has, and this is an ordinary two-argument call.
const _wiredOrders = Module.scoped(WiredOrders, (ctx) => ctx.get(FindOrder).execute("o-1"));

const WiredCustomers = Module("WiredCustomers")({
  imports: [CustomerApplicationModule],
  provides: [customerRepository],
  exports: [FindCustomer],
});

// Positive, and one provider shorter than the orders half: what a vertical
// owes is now its own.
const _wiredCustomers = Module.scoped(WiredCustomers, (ctx) =>
  ctx.get(FindCustomer).execute("c-1"),
);
