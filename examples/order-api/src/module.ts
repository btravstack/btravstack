import { cache } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";
import { Logger, Meter, Tracer } from "@btravstack/core";
import { contract } from "@btravstack/example-order-api-contract";
import { HttpModule } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";

import { api } from "./auth.js";
import { customersController } from "./slices/customers/controller.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { ordersController } from "./slices/orders/controller.js";
import { OrdersSlice } from "./slices/orders/module.js";

/**
 * The router, composed from each slice's own controller — each minted by the
 * contract path it serves, so a path the contract does not declare is a
 * compile error at the mint and a path with no controller is refused here as
 * uncovered.
 */
export const orderRouter = api.HttpRouter(contract)([ordersController, customersController]);

/**
 * The composition root, and a list of **slices**: each imports the vertical it
 * needs, so this file names what the process serves rather than everything every
 * slice depends on. The verticals meet only at the database module both
 * persistence halves import — a diamond di flattens by provider reference, so
 * one connection is built.
 *
 * What is left is what no slice owns: `observability()`, and the `Cache` the
 * customers slice reads through, composed INSTRUMENTED so every cache call lands
 * in the same span tree as everything else and the slice using it declares
 * nothing about observability. The two authenticators are **not** listed — they
 * ride the router, and `HttpModule` puts them in `provides` itself.
 *
 * A constant, not a function: configuration is read inside the graph, so a spec
 * boots this very module with `env: { PORT: "0" }`.
 */
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, cache({ adapter: redisCache() }), observability(), otel()],
  // All three are exported because `RequestModule`, the per-request fork, reads
  // them out of the application scope.
  exports: [Logger, Tracer, Meter],
});
