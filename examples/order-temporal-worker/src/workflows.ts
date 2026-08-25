import { orderContract } from "@btravstack/example-order-temporal-contract";
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
 * The triage rule per step: a DECLARED error is a permanent domain answer —
 * compensate, then re-mint it against `context.errors`. The two machinery tags
 * are Temporal's vocabulary for an activity that failed unmodelled or was
 * cancelled, handed back as-is so `propagateActivityFailure` re-raises the
 * platform's original failure. Compensation deliberately does NOT run on those:
 * a step that died mid-flight left unknown state, and un-deciding what you
 * cannot see is a second bug.
 */
export const fulfillOrder = declareWorkflow({
  workflowName: "fulfillOrder",
  contract: orderContract,
  implementation: (context, args) => {
    // An `AsyncResult` is eager — building a step IS starting its activity — so
    // a sequence must never construct two steps as siblings. `flatTap` runs a
    // failable step, discards its value and passes the original through, which
    // keeps each step's triage at one level of indentation.
    const order = { tenantId: args.tenantId, orderId: args.orderId };

    return propagateActivityFailure(
      context.activities
        .place({ tenantId: args.tenantId, orderId: args.orderId, quantity: args.quantity })
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
            .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) => error),
        )
        .flatTap(() =>
          context.activities
            .reserveStock({
              tenantId: args.tenantId,
              orderId: args.orderId,
              quantity: args.quantity,
            })
            .flatMapErrCases((matcher) =>
              matcher
                // The first walk-back: stock said a permanent no, so the
                // placement is un-decided before the caller hears it.
                .with({ errorName: "OutOfStock" }, (error) =>
                  context.activities
                    .cancelPlacement(order)
                    .flatMap(() => ErrAsync(context.errors.OutOfStock({ id: error.data.id }))),
                )
                .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) =>
                  ErrAsync(error),
                ),
            ),
        )
        .flatTap(() =>
          context.activities.arrangeShipping(order).flatMapErrCases((matcher) =>
            matcher
              // The deeper walk-back, in reverse order of the steps it undoes:
              // release the reservation, then the placement.
              .with({ errorName: "ShippingUnavailable" }, (error) =>
                context.activities
                  .releaseStock(order)
                  .flatMap(() => context.activities.cancelPlacement(order))
                  .flatMap(() =>
                    ErrAsync(context.errors.ShippingUnavailable({ id: error.data.id })),
                  ),
              )
              .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) =>
                ErrAsync(error),
              ),
          ),
        ),
    );
  },
});

/**
 * The billing workflow: authorize, then capture. A capture that fails after a
 * successful authorization is walked back with `refundPayment`, in reverse
 * order of the step it undoes — the same saga shape `fulfillOrder` runs, at
 * the smallest size that still has a compensation.
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
