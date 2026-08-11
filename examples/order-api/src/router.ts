import type { Context } from "@btravstack/di";
import { FindOrder, PlaceOrder } from "@btravstack/start-example-order-application";
import type { Order } from "@btravstack/start-example-order-domain";
import { implement } from "@orpc/server";
import { handlerResult } from "@unthrown/orpc/server";
import { P } from "unthrown";

import { orderContract, type OrderView } from "./contract.js";

/**
 * What every procedure is handed: the request's own di `Context`, seeded from
 * the application scope the kernel built. Passing the context rather than the
 * services keeps the router indifferent to how the request scope was made — the
 * runtime forks it, and this file only reads out of it.
 */
export type ApiContext = { readonly scope: Context<PlaceOrder | FindOrder> };

const os = implement(orderContract).$context<ApiContext>();

const view = (order: Order): OrderView => ({ id: order.id, quantity: order.quantity });

/**
 * The transport boundary, and the only place in this example where a domain
 * error becomes something else.
 *
 * `handlerResult` eliminates the `Result`: `Ok` is the output, an `Err` holding
 * an `ORPCError` is *returned* (so oRPC marks it inferable and the client gets
 * it typed), and a `Defect` rethrows its cause onto oRPC's own defect path,
 * where it collapses to `INTERNAL_SERVER_ERROR`. The `mapErrCases` in between is
 * the triage point: every case of the use case's error type is named, because
 * the matcher has no wildcard to fall back on. A new domain error is a compile
 * error here, at the one place that has to decide what the client sees.
 */
export const orderRouter = os.router({
  orders: {
    place: os.orders.place.handler(
      handlerResult(({ context, errors }, input) =>
        context.scope
          .get(PlaceOrder)
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
    ),
    find: os.orders.find.handler(
      handlerResult(({ context, errors }, input) =>
        context.scope
          .get(FindOrder)
          .execute(input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
      ),
    ),
  },
});
