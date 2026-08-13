import { orderContract } from "@btravstack/start-example-order-temporal-contract";
import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  declareWorkflow,
  propagateActivityFailure,
} from "@temporal-contract/worker/workflow";
import { ErrAsync, P } from "unthrown";

/**
 * The workflow, in its own module — and it has to be.
 *
 * Workflow code runs inside a deterministic V8 sandbox that webpack bundles
 * separately from the worker's own module graph, so it may not sit in a spec
 * file, and it must be free of side effects at module scope: `TypedWorker.create`
 * also imports it in the main thread to check that every declared workflow is
 * exported. Nothing here reaches the di container or the database — those live
 * behind the *activities*, which is where this example's kernel units open.
 *
 * This is the orchestration the deployment exists to demonstrate: place, then
 * reserve, then ship — and when a later step answers a permanent no, walk the
 * earlier ones back before answering the caller. The walk-back is a **saga**,
 * and it lives here because it spans services no one of which can own it; a
 * durable workflow is the one place the whole journey exists as code, and
 * survives the process that started it.
 *
 * The triage rule per step is the same one `contract.ts` describes: a
 * *declared* error is a permanent domain answer — compensate, then re-mint it
 * against `context.errors` so the client sees it typed. The two machinery tags
 * are Temporal's own vocabulary for an activity that failed *unmodelled* (its
 * retries already exhausted) or was cancelled — those are handed back as-is,
 * so `propagateActivityFailure` re-raises the platform's original failure and
 * the execution fails the way an untyped workflow would. Compensation is
 * deliberately NOT run on machinery failures: a step that died mid-flight left
 * unknown state, and un-deciding what you cannot see is a second bug, not a
 * remedy.
 *
 * Compensations run in reverse order of the steps they undo, and their
 * activities declare no errors at all — `cancelPlacement`'s `OrderNotFound`
 * is absorbed inside the activity, because compensating a placement that never
 * landed is a no-op, not a failure. Every case in every matcher is named —
 * this repo bans `P._`.
 */
export const fulfillOrder = declareWorkflow({
  workflowName: "fulfillOrder",
  contract: orderContract,
  implementation: (context, args) => {
    // An `AsyncResult` is eager — building a step IS starting its activity —
    // so every later step is constructed inside the `flatMap` of the one
    // before it, or the "sequence" would run as a race.
    const order = { orderId: args.orderId };

    return propagateActivityFailure(
      context.activities
        .place({ orderId: args.orderId, quantity: args.quantity })
        .mapErrCases((matcher) =>
          matcher
            .with({ errorName: "InvalidQuantity" }, (error) =>
              context.errors.InvalidQuantity({ id: error.data.id }),
            )
            .with({ errorName: "OrderAlreadyPlaced" }, (error) =>
              context.errors.OrderAlreadyPlaced({ id: error.data.id }),
            )
            .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) => error),
        )
        .flatMap((placed) =>
          context.activities
            .reserveStock({ orderId: args.orderId, quantity: args.quantity })
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
            )
            .flatMap(() =>
              context.activities.arrangeShipping(order).flatMapErrCases((matcher) =>
                matcher
                  // The deeper walk-back, in reverse order of the steps it
                  // undoes: release the reservation, then the placement.
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
            )
            .map(() => placed),
        ),
    );
  },
});
