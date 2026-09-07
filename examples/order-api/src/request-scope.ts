import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import {
  FindOrder,
  ListOrders,
  OrderApplicationModule,
  PlaceOrder,
  Tenant,
} from "@btravstack/example-order-application";
import { OrderDatabase, OrderTenantPersistence } from "@btravstack/example-order-infrastructure";
import { UnitSpanModule } from "@btravstack/observability/otel";

import { auth, REPORTING_TENANT } from "./auth.js";

/**
 * A service that exists for the length of one request and is torn down with it.
 *
 * The application scope is opened once, by the kernel, and holds the database.
 * Passing this module as one of `HttpModule`'s `unit` kinds makes each answerer
 * fork a short-lived scope over the one already built, for a request it
 * handles — so a request-scoped provider reads what the parent constructed
 * without rebuilding it, and no handler code manages the fork.
 */
export class RequestSpan extends Port("RequestSpan")<{ readonly finish: () => void }> {}

/**
 * `onStop` is what puts `Scope` in this module's needs, and only a fork (or
 * `Module.scoped`) opens one — so the teardown below cannot be forgotten. It
 * runs while the unit is still open, which is what gives the line the request's
 * own trace id.
 *
 * It is the `anonymous` kind, and the base the other two import: a request that
 * authenticated under no scheme still gets a span and a finish line.
 */
export const RequestModule = Module("Request")({
  // The fork seam: both are read out of the application scope this module is
  // forked from. `UnitSpanModule` rides along, so every request also opens a
  // span carrying the same unit ids the logger stamps.
  needs: [Logger],
  imports: [UnitSpanModule],
  provides: [
    Provider(RequestSpan)({
      inject: { logger: Logger },
      // No histogram here any more: `@btravstack/http-server` records
      // `btravstack.http.duration` at the unit seam, dimensioned by answerer
      // and status — which an application cannot see from inside its own
      // request scope. What is left is the LINE, which is this module's actual
      // subject: a provider whose teardown runs while the unit is still open,
      // so it carries the request's own trace id.
      sync: ({ logger }) => {
        const startedAt = Date.now();
        return {
          finish: () => logger.info("request finished", { durationMs: Date.now() - startedAt }),
        };
      },
      onStop: (span) => span.finish(),
    }),
  ],
  exports: [RequestSpan],
});

/**
 * The `user` kind: the tenant, taken from the principal that scheme resolved,
 * and the orders vertical composed over it.
 *
 * `auth.principals.user` is seeded onto the fork by the answerer, so this is
 * the one place a credential becomes a tenant inside the graph — and the use
 * cases a marked leaf reads off `context.unit` are bound to it before any
 * handler runs.
 *
 * `OrderTenantPersistence` reads `OrderDatabase` out of the application scope
 * rather than importing the database module, so one client serves every
 * request.
 */
export const UserModule = Module("User")({
  needs: [auth.principals.user, OrderDatabase, Logger],
  imports: [RequestModule, OrderTenantPersistence, OrderApplicationModule],
  provides: [
    Provider(Tenant)({
      inject: { principal: auth.principals.user },
      sync: ({ principal }) => principal.tenantId,
    }),
  ],
  exports: [RequestModule, Tenant, PlaceOrder, FindOrder, ListOrders],
});

/**
 * The `service` kind: an API key names no tenant, so the tenant its key was CUT
 * for is what this kind binds — read from the key list rather than from a
 * credential, since that is where the fact lives.
 *
 * It exports `FindOrder` and neither of the other two, which is what makes
 * `context.unit.place` and `context.unit.list` unreadable from `export`, the one
 * leaf both schemes serve: the record a leaf is given is the INTERSECTION of
 * what its kinds export.
 */
export const ServiceModule = Module("Service")({
  needs: [OrderDatabase, Logger],
  imports: [RequestModule, OrderTenantPersistence, OrderApplicationModule],
  provides: [Provider(Tenant)({ inject: {}, value: REPORTING_TENANT })],
  exports: [RequestModule, FindOrder],
});
