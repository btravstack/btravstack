import type { RuntimeHost, UnitMeta } from "@btravstack/core";
import type { ActivityMiddleware } from "@temporal-contract/worker/activity";
import { activityInfo } from "@temporalio/activity";

/**
 * Open one kernel unit per activity attempt. It injects nothing: an activity
 * implementation is a service the graph built, closing over what its provider
 * declared, and the ambient `currentUnit()` record is there for an adapter that
 * wants the trace id.
 *
 * There is deliberately no `Result`-unwrapping boundary: `declareActivitiesHandler`
 * owns the mapping from a settled `Result` to an activity failure, and the
 * kernel maps nothing to a transport.
 */
export const activityUnits =
  (host: RuntimeHost<never>): ActivityMiddleware =>
  (_invocation, next) =>
    host.run(metaFor(), () => next());

/**
 * `UnitMeta.id` must be unique per unit, and a workflow id is **not** one: an
 * activity is retried under the same execution, and Temporal lets a workflow id
 * be reused once an execution closes. A task token identifies one activity task
 * attempt, so its uniqueness is Temporal's guarantee rather than an argument of
 * ours.
 *
 * The workflow id becomes the `traceId`, which is what `traceId` is for — the
 * correlation id, minted outside this process, holding steady across every
 * retry so all attempts join up in a log. An activity with no workflow falls
 * back to the activity id, itself stable across that activity's attempts.
 */
const metaFor = (): UnitMeta => {
  const info = activityInfo();
  return {
    kind: "activity",
    id: info.base64TaskToken,
    traceId: info.workflowExecution?.workflowId ?? info.activityId,
  };
};
