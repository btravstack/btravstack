import { orderContract, type PlacedOrder } from "@btravstack/example-order-temporal-contract";
import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  declareWorkflow,
  propagateFailure,
} from "@temporal-contract/worker/workflow";
import { P } from "unthrown";

/** An already-running workflow version whose activity tasks carry no operation id. */
export const fulfillOrder = declareWorkflow({
  workflowName: "fulfillOrder",
  contract: orderContract,
  implementation: (context, args) => {
    const order = { tenantId: args.tenantId, orderId: args.orderId };
    // A saga answers its LAST step's value, and this workflow answers the
    // PLACEMENT's — so the first step keeps it and the last hands it back. The
    // binding is local to one invocation, which is what replay needs; module
    // scope is the hazard, not this.
    let placed!: PlacedOrder;

    return propagateFailure(
      context
        .saga()
        .step(
          () =>
            context.activities.place({ ...order, quantity: args.quantity }).tap((placement) => {
              placed = placement;
            }),
          () => context.activities.cancelPlacement(order),
        )
        .step(
          () => context.activities.reserveStock({ ...order, quantity: args.quantity }),
          () => context.activities.releaseStock(order),
        )
        .step(() => context.activities.arrangeShipping(order).map(() => placed))
        .run()
        // The saga hands the failure back unchanged, so the re-mint against
        // this workflow's own declared errors happens once, here. Widening any
        // activity's error union fails this match rather than three.
        .mapErrCases((matcher) =>
          matcher
            .with({ errorName: "InvalidQuantity" }, (error) =>
              context.errors.InvalidQuantity({ id: error.data.id }),
            )
            .with({ errorName: "InvalidOrderId" }, (error) =>
              context.errors.InvalidOrderId({ id: error.data.id }),
            )
            .with({ errorName: "OrderAlreadyPlaced" }, (error) =>
              context.errors.OrderAlreadyPlaced({ id: error.data.id }),
            )
            .with({ errorName: "OutOfStock" }, (error) =>
              context.errors.OutOfStock({ id: error.data.id }),
            )
            .with({ errorName: "ShippingUnavailable" }, (error) =>
              context.errors.ShippingUnavailable({ id: error.data.id }),
            )
            .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) => error),
        ),
    );
  },
});
