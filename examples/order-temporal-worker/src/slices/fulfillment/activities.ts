import {
  OrderRepository,
  PlaceOrder,
  ShippingService,
  StockService,
} from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { Storage } from "@btravstack/storage";
import { TemporalWorkflowActivities } from "@btravstack/temporal";
import { P } from "unthrown";

/**
 * The saga's five activities, as a service: the record `fulfillOrder`'s own
 * key on the composed activities port — `TemporalWorkflowActivities(orderContract,
 * "fulfillOrder")` is di's provider builder on that port, typed for the ONE
 * workflow it implements, so no class and no name appear here. Nothing here
 * is a runtime — the Worker's lifecycle, the unit per activity attempt and
 * the release at the kernel's deadline are the package's. This is the
 * application's half: the triage from a domain `Err` to a declared contract
 * error, closing over the use case and the services its provider declared.
 *
 * The provider declares the four ports the activities close over — the
 * placement use case, the repository (its `remove` is `cancelPlacement`'s
 * persistence arm) and the two fulfillment services — and di verifies the
 * composition root supplies them. Nothing is resolved from a context.
 *
 * Typing the piece by the one workflow it implements means an activity the
 * workflow does not declare is a compile error in THIS file, not a defect
 * `declareActivitiesHandler` reports at startup — and the piece declares the
 * four ports this saga calls, not billing's: `PaymentService` is as invisible
 * here as `PlaceOrder` is in the billing slice.
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
 * `args.tenantId` is the tenant the workflow was started with, threaded to
 * every call that touches the database. It arrives on the activity's own
 * input because the CONTRACT declares it — `@btravstack/temporal` knows
 * nothing about tenants, and an input is what Temporal persists in the event
 * history, so a replay reconstructs the tenant along with everything else.
 * `TenantId(args.tenantId)` claims the brand at each activity that needs one —
 * an activity is its own entry point, so `place` and `cancelPlacement` are two
 * boundaries rather than one crossed twice — and the contract validated the
 * field as a UUIDv7 before either was entered.
 *
 * The compensations: `releaseStock`'s port already promises `never`; nothing
 * to triage. `cancelPlacement` absorbs `OrderNotFound` on purpose — undoing a
 * placement that never landed is the no-op a *repeated* compensation performs,
 * and an activity Temporal may re-run has to answer the same both times.
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
