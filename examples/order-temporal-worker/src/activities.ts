import {
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalActivities } from "@btravstack/temporal";
import { P } from "unthrown";

/**
 * The saga's five activities, as a service: the record `declareActivitiesHandler`
 * takes for `orderContract`, on the port `@btravstack/temporal`'s starter
 * resolves it from — `TemporalActivities(orderContract)("OrderActivities")`
 * mints the port and hands back di's provider builder, so the port is
 * `orderActivities.port` and no class names it. Nothing here is a runtime —
 * the Worker's lifecycle, the unit per activity attempt and the release at
 * the kernel's deadline are the package's. This is the application's half:
 * the triage from a domain `Err` to a declared contract error, closing over
 * the use case and the services its provider declared.
 *
 * The provider declares the four ports the activities close over — the
 * placement use case, the repository (its `remove` is `cancelPlacement`'s
 * persistence arm) and the two fulfillment services — and di verifies the
 * composition root supplies them. Nothing is resolved from a context.
 *
 * `place` is the hinge of this whole example. Its `mapErrCases` is the triage
 * point, and the third sibling of `order-api`'s into `ORPCError` codes and a
 * queue consumer's into ack/dead-letter. The same `Err` lands somewhere else
 * again: `DuplicateOrder` is a `CONFLICT` over HTTP because a caller is
 * waiting to be told, and a dead-letter on a queue because none is. Here there
 * *is* a caller — a workflow, and behind it a client — so it becomes a typed
 * contract error the client branches on by name. What is new is the second
 * thing this mapping decides: `contract.ts` declares both of these
 * `nonRetryable`, so naming a failure here is also what tells **Temporal** to
 * stop retrying it. An unmodelled failure stays unnamed and the retry policy
 * takes over — the platform doing for free what the queue worker hand-rolls
 * with an attempt budget. Every case is named: a new domain error is a compile
 * error here, at the one place that has to decide what the workflow sees.
 *
 * The forward steps against the two external services carry the same triage,
 * one case each: the domain's permanent no becomes the declared contract
 * error, which `nonRetryable` in `contract.ts` turns into "stop asking".
 *
 * The compensations: `releaseStock`'s port already promises `never`; nothing
 * to triage. `cancelPlacement` absorbs `OrderNotFound` on purpose — undoing a
 * placement that never landed is the no-op a *repeated* compensation performs,
 * and an activity Temporal may re-run has to answer the same both times.
 */
export const orderActivities = TemporalActivities(orderContract)("OrderActivities")(
  [PlaceOrder, OrderRepository, StockService, ShippingService],
  {
    sync: (place, repository, stock, shipping) => ({
      fulfillOrder: {
        place: (args, { errors }) =>
          place
            .execute(args.orderId, args.quantity)
            .map((order) => ({ id: order.id, quantity: order.quantity }))
            .mapErrCases((matcher) =>
              matcher
                .with(P.tag("InvalidQuantity"), (error) => errors.InvalidQuantity({ id: error.id }))
                .with(P.tag("DuplicateOrder"), (error) =>
                  errors.OrderAlreadyPlaced({ id: error.id }),
                ),
            ),
        reserveStock: (args, { errors }) =>
          stock
            .reserve(args.orderId, args.quantity)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("OutOfStock"), (error) => errors.OutOfStock({ id: error.id })),
            ),
        arrangeShipping: (args, { errors }) =>
          shipping
            .arrange(args.orderId)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("ShippingUnavailable"), (error) =>
                errors.ShippingUnavailable({ id: error.id }),
              ),
            ),
        releaseStock: (args) => stock.release(args.orderId),
        cancelPlacement: (args) =>
          repository
            .remove(args.orderId)
            .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined)),
      },
    }),
  },
);
