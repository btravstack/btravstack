import { pageRequest } from "@btravstack/contract";
import { Logger } from "@btravstack/core";
import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, ListOrders, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { P } from "unthrown";

import { api } from "../../auth.js";
import { exportable, renderCsv } from "./authorize.js";

const view = (order: Order): OrderView => ({ id: order.id, quantity: order.quantity });

/**
 * The transport boundary, and the only place in this slice where a domain error
 * becomes something else.
 *
 * The implementation is a record shaped like the fragment whose leaves are plain
 * `Result`-returning functions, typed by the contract at the call. `mapErrCases`
 * is the triage point: every case of the use case's error type is named, because
 * the matcher has no wildcard — so a new domain error is a compile error here,
 * at the one place that decides what the client sees.
 *
 * The use cases are read off `context.unit`, not injected: a marked leaf opens
 * its unit under the `user` kind, which built them over the tenant that
 * scheme's principal named. `export` names a second scheme, so its kinds are
 * `user | service` and the record it gets is the intersection of the two —
 * `find` and neither of the others.
 *
 * The fragment's inputs name **no** tenant: a caller does not get to name the
 * tenant it is served. The unmarked `customers` fragment still names one, which
 * is where that contrast is legible.
 */
export const ordersController = api.OrpcController(
  contract,
  "orders",
)({
  inject: { logger: Logger },
  unit: { place: PlaceOrder, find: FindOrder, list: ListOrders },
  sync: ({ logger }) => ({
    place: ({ errors, context }, input) => {
      logger.info("order placement requested", { userId: context.principal.userId });
      return context.unit.place
        .execute(input.id, input.quantity)
        .map(view)
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
            )
            // `BAD_REQUEST`, not `CONFLICT`: a malformed id is the caller's
            // mistake. Not dead code behind the fragment's `z.uuidv7()`
            // either — `placeOrder`'s own signature takes a bare `string`.
            //
            // Two paths reach this status: here, and oRPC's own pre-dispatch
            // refusal. What tells them apart is `inferable`, set only when a
            // handler RETURNS an `ORPCError`, which is why one arrives on the
            // error channel and the other on the defect channel.
            .with(P.tag("InvalidOrderId"), (error) =>
              errors.BAD_REQUEST({ message: error.message, data: { id: error.id } }),
            )
            .with(P.tag("DuplicateOrder"), (error) =>
              errors.CONFLICT({ message: error.message, data: { id: error.id } }),
            ),
        );
    },
    find: ({ errors, context }, input) =>
      context.unit.find
        .execute(input.id)
        .map(view)
        .mapErrCases((matcher) =>
          matcher.with(P.tag("OrderNotFound"), (error) =>
            errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
          ),
        ),
    // The listing. The one translation is the CURSOR: the contract carries
    // `after` and `before` as two optional fields and refuses both at once,
    // where the port makes them a union — and `pageRequest` is that crossing,
    // carrying this listing's own filters through untouched.
    //
    // The tenant is not among them. A page of somebody else's orders is not a
    // request this controller can express: the caller has no slot to name a
    // tenant in, and the listing it reaches was built for the fork's own.
    list: ({ errors, context }, input) =>
      context.unit.list
        .execute(pageRequest(input))
        .map((found) => ({ ...found, items: found.items.map(view) }))
        .mapErrCases((matcher) =>
          matcher.with(P.tag("MalformedCursor"), (error) =>
            errors.BAD_REQUEST({
              message: "the cursor could not be read",
              data: { cursor: error.cursor },
            }),
          ),
        ),

    // The third layer, and the only one written by hand: the unit already bound
    // the tenant, so what is left is a decision about THIS order, and
    // `renderCsv` cannot be reached without it.
    export: ({ errors, context }, input) => {
      logger.info("order export requested", {
        id: input.id,
        scheme: context.principal.scheme,
      });
      return context.unit.find
        .execute(input.id)
        .flatMap((order) => exportable(context.principal, order).toAsync())
        .map((authorized) => ({ csv: renderCsv(authorized) }))
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            )
            .with(P.tag("Forbidden"), (error) =>
              errors.FORBIDDEN({
                message: error.message,
                data: { id: error.id, reason: error.reason },
              }),
            ),
        );
    },
  }),
});
