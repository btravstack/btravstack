import {
  observe,
  type Operation,
  type RuntimeHost,
  type Settle,
  type UnitMeta,
} from "@btravstack/core";
import type { ActivityMiddleware } from "@temporal-contract/worker/activity";
import { activityInfo } from "@temporalio/activity";

import type { AnyUnitModule } from "./temporal-runtime.js";

/**
 * Open one kernel unit per activity attempt, forking `unit` — when one is
 * bound — after the activity is invoked, before it runs; the fork is torn down
 * when the unit closes. With no `unit` bound, `next()` runs unchanged, so the
 * ambient `currentUnit()` record is what an adapter reads.
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
  (
    host: RuntimeHost<never>,
    observers: readonly ((operation: Operation) => Settle)[],
    unit: AnyUnitModule | undefined,
  ): ActivityMiddleware =>
  (_invocation, next) => {
    const settle = observe(observers, {
      component: "temporal",
      // Per ATTEMPT, not per activity: an activity is retried under the same
      // execution, so a count per activity would hide exactly the retries worth
      // alerting on. The workflow id is not a dimension and must not be — it is
      // unbounded, and it is already the unit's `traceId`.
      name: "attempt",
      attributes: { activity: activityInfo().activityType },
    });
    return host
      .run(metaFor(), (scope) =>
        unit === undefined ? next() : scope.fork(unit as never, []).flatMap(() => next()),
      )
      .tap(() => settle({ outcome: "ok" }))
      .tapFailure((failure) =>
        settle({
          outcome: "error",
          cause: failure.tag === "Err" ? failure.error : failure.cause,
        }),
      );
  };

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
