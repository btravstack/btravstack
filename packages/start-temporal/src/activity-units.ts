import type { AnyPort, Context } from "@btravstack/di";
import type { RuntimeHost, UnitMeta } from "@btravstack/start";
import { activityInfo } from "@temporalio/activity";
import { P, type AsyncResult } from "unthrown";

/**
 * An activity implementation, Result-first like the rest of this stack.
 * Returning a plain promise is a type error on purpose: the kernel's `UnitWork`
 * requires a Result-bearing return, and a non-Result reaching `units.ts`'s
 * `.flatMap((result) => result)` becomes a `Defect` rather than a value.
 */
export type ActivityImpl<Needs extends AnyPort> = (
  ctx: Context<InstanceType<Needs>>,
  signal: AbortSignal,
  ...args: never[]
  // A heterogeneous `impls` record erases each implementation's own error
  // type, so there is no concrete domain error to name in this boundary
  // type — `asActivities` is what turns every `Err`/`Defect` into a throw.
  // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- see above
) => AsyncResult<unknown, unknown>;

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

// The activity boundary IS the edge of the Result world: Temporal signals
// failure by throwing, and its retry policy reads the thrown cause.
const raise = (cause: unknown): never => {
  // oxlint-disable-next-line unthrown/no-throw -- see above
  throw cause;
};

/**
 * Wrap plain implementations so each attempt becomes one kernel unit. The
 * `temporal-contract` path uses `activityUnits` instead; both produce a record
 * the factory registers without wrapping again.
 */
export const asActivities = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  impls: Record<string, ActivityImpl<Needs>>,
): Record<string, (...args: never[]) => unknown> =>
  Object.fromEntries(
    Object.entries(impls).map(([name, impl]) => [
      name,
      async (...args: never[]) =>
        // THE BOUNDARY. Temporal expects a value or a throw, and an
        // `AsyncResult` is a thenable — returned as-is, Temporal would await
        // it and hand the workflow a `Result` OBJECT instead of the
        // activity's output. So the Result is eliminated here: `Ok` unwraps
        // to the value, `Err` and `Defect` throw their cause.
        //
        // `host.run`'s work callback is generic in `T`/`E`; a heterogeneous
        // `impls` record erases both, so `impl`'s return cannot be shown to
        // satisfy `AsyncResult<T, E> | Promise<Result<T, E>> | Result<T, E>`
        // without naming T/E, which this record cannot do.
        (await host.run(metaFor(), (ctx, signal) => impl(ctx, signal, ...args) as never)).match({
          ok: (value: unknown) => value,
          // Generic `E`: a heterogeneous activity record erases the error
          // type, so no arm list can prove exhaustiveness and the catch-all
          // is the only arm that can terminate the match.
          // oxlint-disable-next-line unthrown/no-catch-all-pattern -- generic `E`, see above
          errCases: (matcher) => matcher.with(P._, (error: unknown) => raise(error)),
          defect: (cause: unknown) => raise(cause),
        }),
    ]),
  );
