/**
 * The compile-time half of the layering, once per vertical:
 * `OrderApplicationModule` declares `OrderRepository` and `Logger` as unmet
 * needs and `CustomerApplicationModule` declares `CustomerRepository`, so di's
 * phantom rest-tuple gate makes scoping either one a call-site arity error
 * until an outer module provides them — and, since the `needs` gate, an outer
 * module that neither provides nor declares them does not compile at all. Two gates rather than one, which is the
 * point of the split: closing the orders half says nothing about the customers
 * half, and the compiler says so at each module rather than once for the
 * layer. Type-checked by this package's `test:types` script, never executed.
 */
import { Module, Provider } from "@btravstack/di";
import {
  CustomerNotFound,
  DuplicateOrder,
  OrderNotFound,
  TenantId,
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
    save: (_tenantId: TenantId, order: Order) => ErrAsync(new DuplicateOrder({ id: order.id })),
    find: (_tenantId: TenantId, id: string) => ErrAsync(new OrderNotFound({ id })),
    remove: (_tenantId: TenantId, id: string) => ErrAsync(new OrderNotFound({ id })),
  },
});

const customerRepository = Provider(CustomerRepository)({
  value: { find: (_tenantId: TenantId, id: string) => ErrAsync(new CustomerNotFound({ id })) },
});

const logger = Provider(Logger)({ value: createLogger(() => {}) });

// Negative: nothing provides `OrderRepository`, so di's rest parameter is a
// required two-element tuple the call does not pass, and `Expected 5 arguments,
// but got 2` is the whole message. An arity error carries no type, so neither
// the label nor the ports are in it; hand-spelling the phantom arguments prints
// them, ending on `not assignable to parameter of type
// 'Logger | OrderRepository'`.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: no OrderRepository is provided.
const _unwiredOrders = Module.scoped(OrderApplicationModule, (ctx) =>
  ctx.get(PlaceOrder).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001", 1),
);

// Negative, the same gate on the sibling module and a different port: the
// customers vertical owes its own repository and nothing else — not the
// logger, which only `PlaceOrder` writes to.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: no CustomerRepository is provided.
const _unwiredCustomers = Module.scoped(CustomerApplicationModule, (ctx) =>
  ctx.get(FindCustomer).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-0000000000c1"),
);

// Negative, per vertical: the orders repository closes the orders module, and
// says nothing about the customers one — a graph that wires the wrong
// vertical's adapter is still rejected. Since di's `needs` gate that is
// refused HERE, at the module with the gap, rather than at `Module.scoped`:
// this root neither provides `CustomerRepository` nor declares it.
// @ts-expect-error — UNDECLARED NEEDS: CustomerRepository.
const MiswiredCustomers = Module("MiswiredCustomers")({
  imports: [CustomerApplicationModule],
  provides: [orderRepository, logger],
  exports: [FindCustomer],
});

void MiswiredCustomers;

// Negative, the other port of the orders pair: the repository alone does not
// close the module, because `PlaceOrder` writes a line — and again the module
// is where that is said, not the entry point.
// @ts-expect-error — UNDECLARED NEEDS: Logger.
const LoglessOrders = Module("LoglessOrders")({
  imports: [OrderApplicationModule],
  provides: [orderRepository],
  exports: [PlaceOrder, FindOrder],
});

void LoglessOrders;

// Negative, and the distinction the two gates now draw: DECLARING the logger
// makes the module itself legal — what is left is that nothing supplies it,
// which is `Module.scoped`'s arity gate and not di's declaration one.
const DeclaredLogless = Module("DeclaredLogless")({
  needs: [Logger],
  imports: [OrderApplicationModule],
  provides: [orderRepository],
  exports: [PlaceOrder, FindOrder],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: no Logger is provided.
const _logless = Module.scoped(DeclaredLogless, (ctx) =>
  ctx.get(FindOrder).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001"),
);

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
const _wiredOrders = Module.scoped(WiredOrders, (ctx) =>
  ctx.get(FindOrder).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-000000000001"),
);

const WiredCustomers = Module("WiredCustomers")({
  imports: [CustomerApplicationModule],
  provides: [customerRepository],
  exports: [FindCustomer],
});

// Positive, and one provider shorter than the orders half: what a vertical
// owes is now its own.
const _wiredCustomers = Module.scoped(WiredCustomers, (ctx) =>
  ctx.get(FindCustomer).execute(TenantId("acme"), "0199a1e0-0000-7000-8000-0000000000c1"),
);
