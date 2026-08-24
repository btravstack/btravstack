import { contract } from "@btravstack/example-order-api-contract";
import { HttpModule } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";
import { Meter, Tracer, otel } from "@btravstack/observability/otel";

import { api } from "./auth.js";
import { customersController } from "./slices/customers/controller.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { ordersController } from "./slices/orders/controller.js";
import { OrdersSlice } from "./slices/orders/module.js";

/**
 * The router, composed from each slice's own controller — an array of
 * pieces, one per top-level contract key. Every fragment the contract
 * declares must be covered by exactly one piece; the key rides each piece's
 * own port id, so an uncovered fragment is a compile error and two slices
 * claiming one fragment is di's duplicate-provider defect at build.
 */
export const orderRouter = api.HttpRouter(contract)([ordersController, customersController]);

/**
 * The composition root, and a list of **slices**: each one imports the vertical
 * it needs, so this file names what the process serves rather than everything
 * every slice happens to depend on. The verticals meet only at the database
 * module both persistence halves import; di flattens the module tree into a
 * `Set` keyed by provider reference, so the diamond builds one connection.
 *
 * What is left here is what no slice owns: `observability()`, whose `Logger`
 * every layer writes to and which is exported because the per-request
 * `RequestModule` reads it out of the application scope. The two
 * authenticators are **not** listed: they ride the router, which is what needs
 * them, and `HttpModule` puts them in `provides` itself — a scheme the
 * contract names with no authenticator behind it is di's own unmet need on
 * `HttpAuthenticator:<scheme>`, not a line this file could forget.
 * Importing the router
 * and the starter is what empties the needs channel (a composition without the
 * router provider does not compile — the starter's provider depends on it, so
 * `HttpRouterPort` survives into `Needs` and `start`'s `module` parameter,
 * which takes only `Scope | Env`, refuses it by name), and `HttpRuntime`,
 * which the sugar exports, is what satisfies the kernel's own marker.
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
  imports: [OrdersSlice, CustomersSlice, observability(), otel()],
  // `Tracer` and `Meter` join `Logger` in the exports for the same reason it
  // is there: `RequestModule` reads them out of the application scope.
  exports: [Logger, Tracer, Meter],
});
