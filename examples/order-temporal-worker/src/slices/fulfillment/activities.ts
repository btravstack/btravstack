import {
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
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
 * `args.tenantId` arrives on the activity's own input because the CONTRACT
 * declares it — the starter knows nothing about tenants — and `TenantId(...)`
 * claims the brand at each activity that needs one, since an activity is its own
 * entry point.
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

export const fulfillOrder = TemporalWorkflowActivities(orderContract, "fulfillOrder")(
  {
    place: PlaceOrder,
    repository: OrderRepository,
    stock: StockService,
    shipping: ShippingService,
    storage: Storage,
  },
  {
    sync: ({ place, repository, stock, shipping, storage }) => ({
      place: (args, { errors }) =>
        place
          .execute(TenantId(args.tenantId), args.orderId, args.quantity)
          .map((order) => ({ id: order.id, quantity: order.quantity }))
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) => errors.InvalidQuantity({ id: error.id }))
              .with(P.tag("InvalidOrderId"), (error) => errors.InvalidOrderId({ id: error.id }))
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
          // The confirmation is stored AFTER the shipment is arranged, as a
          // `flatTap` step — the sequencing discipline this repository states
          // for sagas, and the reason it is not a sibling `const`: an
          // `AsyncResult` is eager, so two constructions would race.
          .flatTap(() =>
            storage
              .put(
                confirmationKey(args.tenantId, args.orderId),
                new TextEncoder().encode(JSON.stringify({ orderId: args.orderId, shipped: true })),
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
      releaseStock: (args) => stock.release(args.orderId),
      cancelPlacement: (args) =>
        repository
          .remove(TenantId(args.tenantId), args.orderId)
          .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined)),
    }),
  },
);
