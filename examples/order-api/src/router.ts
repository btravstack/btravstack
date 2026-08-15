import type { ServiceOf } from "@btravstack/di";
import { orderContract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { HttpRouter } from "@btravstack/http";
import { implement } from "@orpc/server";
import "@unthrown/orpc/extensions/result";
import { P } from "unthrown";

const os = implement(orderContract);

const view = (order: Order): OrderView => ({ id: order.id, quantity: order.quantity });

/**
 * The transport boundary, and the only place in this example where a domain
 * error becomes something else.
 *
 * `.result(...)` — `@unthrown/orpc`'s builder extension, patched in by the
 * import above — eliminates the `Result`: `Ok` is the output, an `Err` holding
 * an `ORPCError` is *returned* (so oRPC marks it inferable and the client gets
 * it typed), and a `Defect` rethrows its cause onto oRPC's own defect path,
 * where it collapses to `INTERNAL_SERVER_ERROR`. The `mapErrCases` in between is
 * the triage point: every case of the use case's error type is named, because
 * the matcher has no wildcard to fall back on. A new domain error is a compile
 * error here, at the one place that has to decide what the client sees.
 *
 * The use cases arrive as arguments, not through oRPC's context: di injects
 * them into the provider below, and oRPC's context is left for what only the
 * HTTP layer knows (nothing, today). One container, not two.
 */
const routerOf = (place: ServiceOf<PlaceOrder>, find: ServiceOf<FindOrder>) =>
  os.router({
    orders: {
      place: os.orders.place.result(({ errors }, input) =>
        place
          .execute(input.id, input.quantity)
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
      ),
      find: os.orders.find.result(({ errors }, input) =>
        find
          .execute(input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
      ),
    },
  });

/**
 * The router as a service, built once from the two use cases it declares —
 * `HttpRouter` mints the port (`orderRouter.port`) and hands back di's own
 * `Provider(port)`, so this is a provider like any other in the graph.
 */
export const orderRouter = HttpRouter("OrderRouter")([PlaceOrder, FindOrder], { sync: routerOf });
