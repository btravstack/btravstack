import type { MeterService, RuntimeHost, UnitMeta } from "@btravstack/core";
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
  (host: RuntimeHost<never>, metrics: TemporalMetrics | undefined): ActivityMiddleware =>
  (_invocation, next) => {
    const startedAt = performance.now();
    const unit = host.run(metaFor(), () => next());
    if (metrics === undefined) return unit;
    const activity = activityInfo().activityType;
    return unit
      .tap(() => metrics.record({ activity, outcome: "ok" }, startedAt))
      .tapFailure(() => metrics.record({ activity, outcome: "error" }, startedAt));
  };

/**
 * Rate, errors and duration, per activity ATTEMPT — not per activity. A
 * retried activity records once per attempt, which is what makes the rate
 * readable when a downstream is failing: the workflow's own count would hide
 * exactly the retries worth alerting on.
 *
 * `activityType` is the dimension, bounded by the contract. The workflow id is
 * not, and that is the point — it is unbounded, and it is already the unit's
 * `traceId`, where an unbounded value belongs.
 */
export type TemporalMetrics = {
  readonly record: (
    attributes: { readonly activity: string; readonly outcome: "ok" | "error" },
    startedAt: number,
  ) => void;
};

export const temporalMetrics = (meter: MeterService | undefined): TemporalMetrics | undefined => {
  if (meter === undefined) return undefined;
  const attempts = meter.createCounter("btravstack.temporal.activity.attempts", {
    description: "Temporal activity attempts, by activity and outcome",
  });
  const duration = meter.createHistogram("btravstack.temporal.activity.duration", {
    description: "Temporal activity attempt duration",
    unit: "ms",
  });
  return {
    record: (attributes, startedAt) => {
      attempts.add(1, attributes);
      duration.record(performance.now() - startedAt, attributes);
    },
  };
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
