import type { UnitMeta } from "@btravstack/start";
import { activityInfo } from "@temporalio/activity";

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
export const metaFor = (): UnitMeta => {
  const info = activityInfo();
  return {
    kind: "activity",
    id: info.base64TaskToken,
    traceId: info.workflowExecution?.workflowId ?? info.activityId,
  };
};
