import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { HttpController } from "@btravstack/http";
import { P } from "unthrown";

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
 * `input.tenantId` is the tenant the caller named, handed straight to the use
 * case. The transport reads nothing about it and the starter knows nothing
 * about it — tenancy is this application's design, declared in its own
 * contract, and `@btravstack/http` has no concept of one.
 *
 * The use cases arrive as arguments, not through oRPC's context: di injects
 * them into the provider — `HttpController(name, contract)` is di's own
 * `Provider(port)` on a port it mints for this controller, so this is a
 * provider like any other in the graph.
 */
export const ordersController = HttpController("OrdersController", contract.orders)(
  [PlaceOrder, FindOrder],
  {
    sync: (place, find) => ({
      place: ({ errors }, input) =>
        place
          .execute(input.tenantId, input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({ message: error.message, data: { id: error.id } }),
              ),
          ),
      find: ({ errors }, input) =>
        find
          .execute(input.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
    }),
  },
);
