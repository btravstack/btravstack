import { cache } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";
import { Logger, Meter, Tracer } from "@btravstack/core";
import { contract } from "@btravstack/example-order-api-contract";
import { OrderDatabase, OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule } from "@btravstack/http-server";
import { oidc } from "@btravstack/http-server/oidc";
import { sessionCodec } from "@btravstack/http-server/session";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";

import { api, principal } from "./auth.js";
import { RequestModule, ServiceModule, SessionModule, UserModule } from "./request-scope.js";
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
 * observability. The authenticators are **not** listed — they ride the router
 * and the fragments provider, and `HttpModule` puts them in `provides` itself.
 *
 * The four `unit` kinds are what a request is served under: `anonymous` for a
 * request nothing marked, `user` for one the bearer scheme resolved — which is
 * where the tenant and the orders vertical are built — `service` for an
 * API key, whose tenant is the one the key was cut for, and `session` for a
 * browser holding the cookie the login answerer sealed, which is `user`'s own
 * shape over the other principal. Each is forked over this scope, so
 * every need they carry is discharged from what is exported below.
 *
 * A factory over the kind modules, not a constant, for one reason: a
 * spec has to substitute a provider INSIDE `UserModule`, and
 * `@btravstack/testing`'s `overridden` wraps the root while a unit module is
 * forked later, so this parameter is the only seam that reaches it. `OrderApi`
 * below is the real root — the factory applied to the real modules, with no
 * override anywhere in it. Configuration is still read inside the graph, so a
 * spec boots that module with `env: { PORT: "0" }`.
 */
export const orderApiOver = (unit: {
  readonly anonymous: typeof RequestModule;
  readonly user: typeof UserModule;
  readonly service: typeof ServiceModule;
  readonly session: typeof SessionModule;
}) =>
  HttpModule("OrderApi")({
    router: orderRouter,
    fragments: orderFragments,
    fragmentsLogin: "/auth/login",
    unit,
    imports: [
      OrdersSlice,
      CustomersSlice,
      OrderPersistenceModule,
      cache({ adapter: redisCache() }),
      observability(),
      otel(),
    ],
    // The session cookie's codec and the login answerer that seals it: the
    // scheme reading the cookie rides `fragments` like the other two ride
    // `router`, and the codec is what ties the two halves to one key list.
    provides: [sessionCodec(), oidc({ principal, scope: "openid orders:export" })],
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
  session: SessionModule,
});
