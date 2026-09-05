import { cache } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";
import { Logger, Meter, Tracer } from "@btravstack/core";
import { contract } from "@btravstack/example-order-api-contract";
import { OrderDatabase, OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";

import { api } from "./auth.js";
import { RequestModule, ServiceModule, UserModule } from "./request-scope.js";
import { customersController } from "./slices/customers/controller.js";
import { CustomersSlice } from "./slices/customers/module.js";
import { ordersController } from "./slices/orders/controller.js";
import { orderRowFragment } from "./slices/orders/fragment.js";
import { OrdersSlice } from "./slices/orders/module.js";

/**
 * The router, composed from each slice's own controller — each minted by the
 * contract path it serves, so a path the contract does not declare is a
 * compile error at the mint and a path with no controller is refused here as
 * uncovered.
 */
export const orderRouter = api.OrpcRouter(contract)([ordersController, customersController]);

/** The fragments, composed from the orders slice's own route. */
export const orderFragments = api.HtmxFragments([orderRowFragment]);

/**
 * The composition root, and a list of **slices** plus what no slice owns: the
 * database, `observability()`, and the `Cache` the customers slice reads
 * through, composed INSTRUMENTED so every cache call lands in the same span
 * tree as everything else and the slice using it declares nothing about
 * observability. The two authenticators are **not** listed — they ride the
 * router, and `HttpModule` puts them in `provides` itself.
 *
 * The three `unit` kinds are what a request is served under: `anonymous` for a
 * request nothing marked, `user` for one the bearer scheme resolved — which is
 * where the tenant and the orders vertical are built — and `service` for an
 * API key, which has no tenant of its own. Each is forked over this scope, so
 * every need they carry is discharged from what is exported below.
 *
 * A constant, not a function: configuration is read inside the graph, so a spec
 * boots this very module with `env: { PORT: "0" }`.
 */
export const orderApiOver = (unit: {
  readonly anonymous: typeof RequestModule;
  readonly user: typeof UserModule;
  readonly service: typeof ServiceModule;
}) =>
  HttpModule("OrderApi")({
    router: orderRouter,
    fragments: orderFragments,
    unit,
    imports: [
      OrdersSlice,
      CustomersSlice,
      OrderPersistenceModule,
      cache({ adapter: redisCache() }),
      observability(),
      otel(),
    ],
    // Everything a forked kind reads out of the application scope: the three
    // observability ports and the one database client every request's
    // repository is built over.
    exports: [Logger, Tracer, Meter, OrderDatabase],
  });

/** The real one. A spec substitutes a stub inside a kind and composes the same root. */
export const OrderApi = orderApiOver({
  anonymous: RequestModule,
  user: UserModule,
  service: ServiceModule,
});
