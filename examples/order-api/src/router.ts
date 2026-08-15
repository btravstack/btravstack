import type { ServiceOf } from "@btravstack/di";
import { orderContract, type OrderView } from "@btravstack/example-order-api-contract";
import type { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { implement } from "@orpc/server";
import "@unthrown/orpc/extensions/result";
import { P } from "unthrown";

/**
 * What every procedure is handed: the two use cases, resolved once by
 * `ApiModule`'s provider — the router declares nothing about di and reads
 * nothing out of a context, so it is a pure function of the contract and the
 * services it is given.
 */
export type ApiContext = {
  readonly place: ServiceOf<PlaceOrder>;
  readonly find: ServiceOf<FindOrder>;
};

const os = implement(orderContract).$context<ApiContext>();

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
 */
export const orderRouter = os.router({
  orders: {
    place: os.orders.place.result(({ context, errors }, input) =>
      context.place
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
    find: os.orders.find.result(({ context, errors }, input) =>
      context.find
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
