import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { Logger } from "@btravstack/observability";
import { P } from "unthrown";

import { HttpController } from "../../auth.js";

const view = (order: Order): OrderView => ({ id: order.id, quantity: order.quantity });

/**
 * The transport boundary, and the only place in this slice where a domain
 * error becomes something else.
 *
 * `HttpController(name, contract.orders)` is contract-first: the implementation
 * is a record shaped like the fragment whose leaves are plain `Result`-returning
 * functions, typed by the contract at the call — the input is the contract's
 * parsed input, the output its declared view, `errors` its declared error
 * map, and a typo'd or missing procedure is a compile error. `implement`,
 * `os.…`, `.result(...)` and `os.router(...)` are what the starter does with
 * it. In each handler, `Ok` is the output, an `Err` holding an `ORPCError` is
 * *returned* (so oRPC marks it inferable and the client gets it typed), and a
 * `Defect` rethrows its cause onto oRPC's own defect path, where it collapses
 * to `INTERNAL_SERVER_ERROR`. The `mapErrCases` in between is the triage
 * point: every case of the use case's error type is named, because the
 * matcher has no wildcard to fall back on. A new domain error is a compile
 * error here, at the one place that has to decide what the client sees.
 *
 * The tenant comes off `context.principal`, the value this application's own
 * authenticator resolved from the request's headers — `contract.orders` is
 * marked `authenticated`, so the principal is typed here and a handler that
 * misreads it does not compile. `HttpController` is `../../auth.ts`'s, minted
 * by `httpAuth<Identity>()`, which is why the principal has a readable type at
 * all: the contract says only that the route is protected, and the factory is
 * what puts this deployment's own identity in scope where the handler is
 * written. Who placed an order is a transport-boundary fact, so it is logged
 * here rather than pushed through a use case that has no business with it. The fragment's inputs name **no** tenant: a
 * caller does not get to name the tenant it is served, and a required field
 * these handlers ignore would be a lie in the contract. The unmarked
 * `customers` fragment still names one, which is where that contrast is
 * legible. The starter knows nothing about tenancy either way — it resolved a
 * principal this application defined, and what the fields on it mean is the
 * application's business.
 *
 * The use cases arrive as arguments, not through oRPC's context: di injects
 * them into the provider — `HttpController(name, contract)` is di's own
 * `Provider(port)` on a port it mints for this controller, so this is a
 * provider like any other in the graph.
 */
export const ordersController = HttpController("OrdersController", contract.orders)(
  { place: PlaceOrder, find: FindOrder, logger: Logger },
  {
    sync: ({ place, find, logger }) => ({
      place: ({ errors, context }, input) => {
        logger.info("order placement requested", { userId: context.principal.userId });
        return place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({ message: error.message, data: { id: error.id } }),
              ),
          );
      },
      find: ({ errors, context }, input) =>
        find
          .execute(context.principal.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
    }),
  },
);
