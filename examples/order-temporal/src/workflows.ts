import { orderContract } from "@btravstack/start-example-order-temporal-contract";
import {
  ACTIVITY_CANCELLED_ERROR_TAG,
  ACTIVITY_ERROR_TAG,
  declareWorkflow,
  propagateActivityFailure,
} from "@temporal-contract/worker/workflow";
import { P } from "unthrown";

/**
 * The workflow, in its own module — and it has to be.
 *
 * Workflow code runs inside a deterministic V8 sandbox that webpack bundles
 * separately from the worker's own module graph, so it may not sit in a spec
 * file, and it must be free of side effects at module scope: `TypedWorker.create`
 * also imports it in the main thread to check that every declared workflow is
 * exported. Nothing here reaches the di container or the database — those live
 * behind the *activity*, which is where this example's kernel unit is opened.
 *
 * The body is the second half of the triage `contract.ts` describes. An
 * activity-declared contract error is rehydrated **here**, and the client never
 * sees it; a workflow-declared one is rehydrated **at the client**. So the two
 * domain failures are re-minted against `context.errors` and everything else is
 * handed to `propagateActivityFailure`, which re-raises Temporal's original
 * failure so the platform classifies the execution exactly as it would have if
 * the activity call had thrown.
 *
 * Every case is named — this repo bans `P._`, and the two activity-machinery
 * arms are as much a decision as the two domain ones.
 */
export const placeOrder = declareWorkflow({
  workflowName: "placeOrder",
  contract: orderContract,
  implementation: (context, args) =>
    propagateActivityFailure(
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
            // The activity failed for a reason nobody declared, and Temporal
            // has already exhausted the contract's retry policy. Handing the
            // wrapper straight back lets `propagateActivityFailure` re-raise
            // the failure underneath it, so the execution fails the way an
            // untyped Temporal workflow would. Both machinery tags are named,
            // grouped into one arm because they share a handler.
            .with(P.tag(ACTIVITY_ERROR_TAG), P.tag(ACTIVITY_CANCELLED_ERROR_TAG), (error) => error),
        ),
    ),
});
