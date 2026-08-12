import type { AnyPort, Context } from "@btravstack/di";
import type { RuntimeHost, UnitMeta } from "@btravstack/start";
import { activityInfo } from "@temporalio/activity";

export type ActivityImpl<Needs extends AnyPort> = (
  ctx: Context<InstanceType<Needs>>,
  signal: AbortSignal,
  ...args: never[]
) => unknown;

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
      (...args: never[]) =>
        // `host.run`'s work callback is generic in `T`/`E`; a heterogeneous
        // `impls` record erases both, so `impl`'s `unknown` return cannot be
        // shown to satisfy `AsyncResult<T, E> | Promise<Result<T, E>> |
        // Result<T, E>` without naming T/E, which this record cannot do.
        host.run(metaFor(), (ctx, signal) => impl(ctx, signal, ...args) as never),
    ]),
  );
