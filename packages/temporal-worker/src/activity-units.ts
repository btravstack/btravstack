import type { RuntimeHost, UnitMeta } from "@btravstack/core";
import type { ActivityMiddleware } from "@temporal-contract/worker/activity";
import { activityInfo } from "@temporalio/activity";

/**
 * Open one kernel unit per activity attempt. It injects nothing — `next()`
 * unchanged — so the ambient `currentUnit()` record is what an adapter reads.
 *
 * **That includes the kernel's per-unit `AbortSignal`**, and it is the only
 * route to it: an activity has no parameter to receive one through. Temporal's
 * own `Context.current().cancellationSignal` is a DIFFERENT clock, so the two
 * are honoured together rather than one standing in for the other.
 *
 * No `Result`-unwrapping boundary, deliberately: `declareActivitiesHandler` owns
 * the mapping from a settled `Result` to an activity failure.
 */
export const activityUnits =
  (host: RuntimeHost<never>): ActivityMiddleware =>
  (_invocation, next) =>
    host.run(metaFor(), () => next());

/**
 * `UnitMeta.id` must be unique per unit, and a workflow id is **not** one: an
 * activity is retried under the same execution. A task token identifies one
 * attempt, so its uniqueness is Temporal's guarantee rather than ours.
 *
 * The workflow id becomes the `traceId` — minted outside this process and steady
 * across every retry, so all attempts join up in a log. An activity with no
 * workflow falls back to the activity id.
 */
const metaFor = (): UnitMeta => {
  const info = activityInfo();
  return {
    kind: "activity",
    id: info.base64TaskToken,
    traceId: info.workflowExecution?.workflowId ?? info.activityId,
  };
};
