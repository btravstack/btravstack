import { orderContract } from "@btravstack/example-order-api-contract";
import { ApplicationModule } from "@btravstack/example-order-application";
import { PersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule, HttpRouter } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";

import { customersController } from "./slices/customers/controller.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { ordersController } from "./slices/orders/controller.js";
import { OrdersSlice } from "./slices/orders/module.js";

/**
 * The router, composed from each slice's own controller — keyed by the
 * contract's own top-level keys, so a key the contract does not declare is a
 * compile error and a declared key with no controller is too.
 */
export const orderRouter = HttpRouter(orderContract)({
  orders: ordersController,
  customers: customersController,
});

/**
 * The composition root, and the only file in the example that knows the five
 * pieces exist. Importing them is what closes di's arity gate (a composition
 * without the router provider does not compile — the starter's provider
 * depends on it), and the exports here are exactly what `start` resolves
 * (`HttpRuntime`) and what the per-request `RequestModule` reads (`Logger`),
 * which closes the kernel's.
 *
 * A constant, not a function: configuration is read inside the graph, from the
 * `Env` port the kernel provides, so nothing has to be passed in from
 * `main.ts` — and a spec boots this very module with `env: { PORT: "0" }`.
 *
 * `PersistenceModule`'s database provider is resourceful, so this module carries
 * a `Scope` need that only `Module.scoped` discharges — which is what `start`
 * does, once, for the whole process.
 */
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [ApplicationModule, PersistenceModule, OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
