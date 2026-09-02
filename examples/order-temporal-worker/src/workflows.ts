import { orderContract, type PlacedOrder } from "@btravstack/example-order-temporal-contract";
import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  declareWorkflow,
  propagateActivityFailure,
} from "@temporal-contract/worker/workflow";
import { ErrAsync, P } from "unthrown";

/**
 * Both workflows, in their own module, and it has to be one: workflow code runs
 * inside a deterministic V8 sandbox bundled separately from the worker's own
 * module graph, and must be free of side effects at module scope. Nothing here
 * reaches the container or the database — those live behind the ACTIVITIES.
 *
 * Place, then reserve, then ship — and when a later step answers a permanent no,
 * walk the earlier ones back before answering the caller. The walk-back is a
 * **saga**, and it lives here because it spans services no one of which can own
 * it.
 *
 * `context.saga()` owns both halves of that: the LIFO unwind, and the rule for
 * which failures earn one. A DECLARED error is a permanent domain answer, so it
 * compensates; an activity that failed unmodelled or was cancelled does not,
 * because a step that died mid-flight left unknown state and un-deciding what
 * you cannot see is a second bug. That leaves ONE triage at the end, re-minting
 * each declared error against `context.errors`, in place of the per-step
 * machinery-tag arm this file used to repeat three times.
 */
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

    return propagateActivityFailure(
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

/**
 * The billing workflow: authorize, then capture. A capture that fails after a
 * successful authorization is walked back with `refundPayment`, in reverse
 * order of the step it undoes.
 *
 * Hand-written where `fulfillOrder` uses `context.saga()`, and deliberately:
 * `capturePayment` declares no errors of its own, so anything it fails with is
 * a machinery tag — the one case the saga's policy refuses to compensate. That
 * default is right for a step whose failure left unknown state, and wrong
 * here, where unknown state is exactly when the money has to go back. The two
 * spellings coexist rather than the policy growing a per-workflow escape.
 */
export const chargeOrder = declareWorkflow({
  workflowName: "chargeOrder",
  contract: orderContract,
  implementation: (context, args) =>
    propagateActivityFailure(
      context.activities
        .authorizePayment({ tenantId: args.tenantId, orderId: args.orderId, amount: args.amount })
        .mapErrCases((matcher) =>
          matcher
            .with({ errorName: "PaymentDeclined" }, (error) =>
              context.errors.PaymentDeclined({ id: error.data.id }),
            )
            .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) => error),
        )
        .flatTap((authorized) =>
          context.activities
            .capturePayment({
              tenantId: args.tenantId,
              authorizationId: authorized.authorizationId,
            })
            .flatMapErrCases((matcher) =>
              matcher.with(
                P.tag(ACTIVITY_ERROR_TAG),
                P.tag(ACTIVITY_CANCELLED_ERROR_TAG),
                (error) =>
                  context.activities
                    .refundPayment({
                      tenantId: args.tenantId,
                      authorizationId: authorized.authorizationId,
                    })
                    .flatMap(() => ErrAsync(error)),
              ),
            ),
        ),
    ),
});
