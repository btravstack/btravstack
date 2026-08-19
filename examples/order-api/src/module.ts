import { contract } from "@btravstack/example-order-api-contract";
import { HttpModule, HttpRouter } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";

import { bearerAuthenticator } from "./authenticator.js";
import { customersController } from "./slices/customers/controller.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { ordersController } from "./slices/orders/controller.js";
import { OrdersSlice } from "./slices/orders/module.js";

/**
 * The router, composed from each slice's own controller — keyed by the
 * contract's own top-level keys, so a key the contract does not declare is a
 * compile error and a declared key with no controller is too.
 */
export const orderRouter = HttpRouter(contract)({
  orders: ordersController,
  customers: customersController,
});

/**
 * The composition root, and a list of **slices**: each one imports the vertical
 * it needs, so this file names what the process serves rather than everything
 * every slice happens to depend on. The verticals meet only at the database
 * module both persistence halves import; di flattens the module tree into a
 * `Set` keyed by provider reference, so the diamond builds one connection.
 *
 * What is left here is what no slice owns: `observability()`, whose `Logger`
 * every layer writes to and which is exported because the per-request
 * `RequestModule` reads it out of the application scope, and the
 * `authenticator` — one per process, because who a caller is is not a slice's
 * question. It is required here and nowhere else because the contract marks
 * `orders`: the router provider carries `AuthenticatorPort` as a need, so
 * dropping this line is an unmet dependency `start` refuses, and supplying one
 * that resolves a different principal is a compile error at this very call.
 * Importing the router
 * and the starter is what closes di's arity gate (a composition without the
 * router provider does not compile — the starter's provider depends on it),
 * and `HttpRuntime`, which the sugar exports, is what closes the kernel's.
 *
 * A constant, not a function: configuration is read inside the graph, from the
 * `Env` port the kernel provides, so nothing has to be passed in from
 * `main.ts` — and a spec boots this very module with `env: { PORT: "0" }`.
 *
 * The database provider under both slices is resourceful, so this module
 * carries a `Scope` need that only `Module.scoped` discharges — which is what
 * `start` does, once, for the whole process.
 */
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  authenticator: bearerAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
