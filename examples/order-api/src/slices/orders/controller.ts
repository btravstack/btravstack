import { Logger } from "@btravstack/core";
import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import { OkAsync, P } from "unthrown";

import { api } from "../../auth.js";

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
 * The tenant comes off `context.principal`, which this application's own
 * authenticator resolved: the contract says only which schemes protect the
 * route, and `defineHttp({ authenticators })` is what says what each resolves
 * to. `export` names a second scheme, so its principal is a discriminated union
 * the handler has to narrow; the other two read `tenantId` bare.
 *
 * The fragment's inputs name **no** tenant: a caller does not get to name the
 * tenant it is served. The unmarked `customers` fragment still names one, which
 * is where that contrast is legible.
 */
export const ordersController = api.HttpController("OrdersController", contract.orders)(
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
        find
          .execute(context.principal.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
            ),
          ),
      // A stand-in body naming the arm that produced it, so a spec pins which
      // scheme served the call. A missing arm leaves a path returning nothing,
      // which the handler's return type refuses.
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            logger.info("order export requested", { userId: context.principal.identity.userId });
            return OkAsync({ csv: `user,${context.principal.identity.userId}` });
          case "service":
            logger.info("order export requested", { appId: context.principal.identity.appId });
            return OkAsync({ csv: `service,${context.principal.identity.appId}` });
        }
      },
    }),
  },
);
