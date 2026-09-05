import {
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { Storage } from "@btravstack/storage";
import { TemporalWorkflowActivities } from "@btravstack/temporal-worker";
import { P } from "unthrown";

/**
 * The saga's five activities, as a piece typed for the ONE workflow it
 * implements — so an activity the workflow does not declare is a compile error
 * in THIS file rather than a startup defect, and the piece declares the four
 * ports this saga calls, not billing's.
 *
 * `place`'s `mapErrCases` is the triage point, and the third sibling of
 * `order-api`'s into `ORPCError` codes and a queue consumer's into
 * ack/dead-letter. Naming a failure here decides a second thing besides what the
 * client sees: `contract.ts` declares these `nonRetryable`, so it is also what
 * tells **Temporal** to stop retrying. An unmodelled failure stays unnamed and
 * the retry policy takes over.
 *
 * `input.tenantId` arrives on the activity's own input because the CONTRACT
 * declares it — the starter knows nothing about tenants — and
 * `ActivityUnitModule` is what turns it into the fork's `Tenant`, once per
 * attempt. So the use cases below come off `context.unit` already bound to
 * this attempt's tenant, and no activity claims the brand.
 *
 * `cancelPlacement` absorbs `OrderNotFound` on purpose: undoing a placement that
 * never landed is the no-op a REPEATED compensation performs, and an activity
 * Temporal may re-run has to answer the same both times.
 */
/**
 * Where a confirmation lives.
 *
 * The tenant is in the key because the port has no slot for one — the same
 * rule the cache key follows, and the same reason: a store is an application
 * service and the framework has no concept of a tenant to put there.
 */
const confirmationKey = (tenantId: string, orderId: string): string =>
  `orders/${tenantId}/${orderId}/confirmation.json`;

export const fulfillOrder = TemporalWorkflowActivities(
  orderContract,
  "fulfillOrder",
)({
  inject: { stock: StockService, shipping: ShippingService, storage: Storage },
  unit: { place: PlaceOrder, repository: OrderRepository },
  sync: ({ stock, shipping, storage }) => ({
    place: ({ errors, context, input }) =>
      context.unit.place
        .execute(input.orderId, input.quantity)
        .map((order) => ({ id: order.id, quantity: order.quantity }))
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) => errors.InvalidQuantity({ id: error.id }))
            .with(P.tag("InvalidOrderId"), (error) => errors.InvalidOrderId({ id: error.id }))
            .with(P.tag("DuplicateOrder"), (error) => errors.OrderAlreadyPlaced({ id: error.id })),
        ),
    reserveStock: ({ errors, input }) =>
      stock
        .reserve(input.orderId, input.quantity)
        .mapErrCases((matcher) =>
          matcher.with(P.tag("OutOfStock"), (error) => errors.OutOfStock({ id: error.id })),
        ),
    arrangeShipping: ({ errors, input }) =>
      shipping
        .arrange(input.orderId)
        // The confirmation is stored AFTER the shipment is arranged, as a
        // `flatTap` step — the sequencing discipline this repository states
        // for sagas, and the reason it is not a sibling `const`: an
        // `AsyncResult` is eager, so two constructions would race.
        .flatTap(() =>
          storage
            .put(
              confirmationKey(input.tenantId, input.orderId),
              new TextEncoder().encode(JSON.stringify({ orderId: input.orderId, shipped: true })),
              { contentType: "application/json" },
            )
            // A document that failed to store must not un-ship an order, so
            // the failure is recovered right here — and recovering it is
            // safe rather than silent BECAUSE the store is composed
            // instrumented: the error line and the counter still happen,
            // one layer down, without this activity carrying a logger.
            .recoverErrCases((matcher) =>
              matcher.with(P.tag("StorageUnavailable"), () => undefined),
            ),
        )
        .mapErrCases((matcher) =>
          matcher.with(P.tag("ShippingUnavailable"), (error) =>
            errors.ShippingUnavailable({ id: error.id }),
          ),
        ),
    releaseStock: ({ input }) => stock.release(input.orderId),
    cancelPlacement: ({ context, input }) =>
      context.unit.repository
        .remove(input.orderId)
        .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined)),
  }),
});
