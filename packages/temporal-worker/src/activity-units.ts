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
import { UNIT_SCOPE } from "./unit.js";
import { ActivityInputPort } from "./workflow-activities.js";

/**
 * Open one kernel unit per activity attempt, forking `unit` — when one is
 * bound — after the activity is invoked, before it runs; the fork is torn down
 * when the unit closes. It is seeded with the validated input on
 * `ActivityInput(contract)`, so a unit module derives a tenant from the
 * invocation rather than reading one off an ambient record. With no `unit`
 * bound, `next()` runs unchanged, so the ambient `currentUnit()` record is what
 * an adapter reads.
 *
 * The forked context rides the invocation's context under {@link UNIT_SCOPE},
 * where each piece's own wrapper turns it into the typed `context.unit` record
 * that piece declared — the records live with the pieces, so a hand-composed
 * `temporal()` gets them without threading a second option through the starter,
 * and the middleware never has to map Temporal's FLAT activity name back to the
 * workflow key its piece was minted under.
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
  (invocation, next) => {
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
        unit === undefined
          ? next()
          : // `as never`: `AnyUnitModule` erases a module's Needs to `unknown` —
            // the only bound a module with real needs can infer against — so
            // `fork`'s own `DependencyGate` sees `Exclude<unknown, Scope>`,
            // still `unknown`, and never clears on its own. The needs were
            // already checked once, at the `Unit`-generic call site that bound
            // this module (`temporal()`'s own type parameter, proven by
            // `examples/order-temporal-worker/src/needs-gate.test-d.ts`'s
            // positive/negative pair) — this reasserts that proof rather than
            // bypassing it.
            scope
              .fork(unit as never, [[ActivityInputPort, invocation.input]] as never)
              .flatMap((forked) => next({ context: { [UNIT_SCOPE]: forked } } as never)),
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
