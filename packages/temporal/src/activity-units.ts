import type { RuntimeHost, UnitMeta } from "@btravstack/core";
import type { AnyPort, Context } from "@btravstack/di";
import { activityInfo } from "@temporalio/activity";
import type { AsyncResult } from "unthrown";

/** What the middleware injects downstream: the application context, and nothing else. */
export type ActivityUnitContext<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
};

/**
 * The shape of `temporal-contract`'s `ActivityMiddleware`, declared here rather
 * than imported. Structural typing makes the two compatible, and it keeps
 * `temporal-contract` out of this package's peer range — a consumer who does
 * not use it should never see it in their dependency graph.
 */
export type ActivityMiddleware<Needs extends AnyPort> = (
  invocation: {
    readonly activityName: string;
    readonly workflowName: string | undefined;
    readonly input: unknown;
    readonly context: Record<never, never>;
  },
  next: (patch?: {
    readonly input?: unknown;
    readonly context?: ActivityUnitContext<Needs>;
    // oxlint-disable-next-line unthrown/no-ambiguous-error-type -- the chain's failure union is `temporal-contract`'s to name; this package is transparent to it and must accept whatever arrives
  }) => AsyncResult<unknown, unknown>,
) => AsyncResult<unknown, never>;

/**
 * Open one kernel unit per activity attempt, and hand the unit's context —
 * the application context, or the per-unit fork when `StartOptions.unit` is
 * set — downstream through `temporal-contract`'s own per-invocation context
 * channel.
 *
 * There is deliberately no `Result`-unwrapping boundary: `declareActivitiesHandler`
 * owns the mapping from a settled `Result` to an activity failure, and the
 * kernel maps nothing to a transport.
 *
 * **Pass the type argument** — `activityUnits<typeof PlaceOrder | typeof Logger>(host)`
 * — whenever an activity implementation reads `context.ctx`. TypeScript infers
 * the injected context from the middleware's type, and it infers nothing from a
 * generic call it is still resolving: written bare and inline, the
 * implementations see an empty context. Hoisting the call into a `const` works
 * too; the type argument is the shorter of the two.
 */
export const activityUnits =
  <Needs extends AnyPort>(host: RuntimeHost<Needs>): ActivityMiddleware<Needs> =>
  (_invocation, next) =>
    // The one cast in the package, and it is what buys a consumer the
    // one-line seam: `declareActivitiesHandler` infers the injected context
    // from this middleware's *own* signature and infers nothing at all from a
    // generic one, so the failure channel cannot be a type parameter here.
    //
    // The `never` is not a claim that nothing fails — whatever `next` produces
    // is passed back untouched. It is the only channel that TYPES: the value
    // must be assignable to the `ApplicationFailure | ContractError` union
    // `temporal-contract` names and this package deliberately does not import,
    // `AsyncResult` is covariant in its error, and `unknown` on the way out is
    // therefore rejected outright (verified). `unknown` on the way in and
    // `never` on the way out is the widest accepted / narrowest offered pair,
    // and `declareActivitiesHandler` re-widens it on the other side.
    host.run(metaFor(), (ctx) => next({ context: { ctx } })) as AsyncResult<unknown, never>;

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
