import {
  SCHEDULE_ALREADY_EXISTS_ERROR_TAG,
  type ScheduleNotFoundError,
  type TypedScheduleClient,
  type TypedScheduleCreateOptions,
  type WorkflowNotInContractError,
  type WorkflowValidationError,
} from "@temporal-contract/client";
import type { ContractDefinition } from "@temporal-contract/contract";
import { ErrAsync, P, type AsyncResult } from "unthrown";

/** Whether the schedule had to be created, or was already there and had its spec reconciled. */
export type ScheduleOutcome = "created" | "updated";

/**
 * Register a schedule, idempotently.
 *
 * `TypedScheduleClient.create` answers `ScheduleAlreadyExistsError` for a
 * schedule id already in use, which is correct and is also the wrong shape for
 * the one place schedules are actually registered: a **deploy**, which runs
 * again on every release. So the second run of a correct deploy script fails,
 * and the usual repair is a `try`/ignore that also swallows the case where the
 * schedule exists with the WRONG spec — a cron nobody notices has stopped
 * matching what the code says.
 *
 * This recovers exactly that one error into an `update`. Every other error
 * stays on the channel, still typed.
 *
 * **`spec`, the action's `workflowType` and `args`, and `policies` are
 * reconciled**; everything else about an existing schedule is left as it
 * stands.
 *
 * - **`args` and `workflowType` are written, and they are checked on the way
 *   through.** The typed handle's `update` validates the returned action's
 *   `args` against the named workflow's input schema before anything is
 *   persisted, and answers `WorkflowValidationError` — the same error `create`
 *   answers, already on this channel. So a deploy that changed what the
 *   workflow takes is either written or refused, never reported `"updated"`
 *   over a server still holding the old action. `workflowType` rides with them
 *   because it is what selects the schema those args are checked against.
 * - **`state` is deliberately preserved.** A schedule an operator paused stays
 *   paused across a deploy, because unpausing it is a decision a person made
 *   and a deploy is not the place to reverse it.
 * - **`memo`, `searchAttributes` and the action's own overrides are
 *   preserved**, because rebuilding the action wholesale means reproducing
 *   `create`'s own assembly here — the task queue off the contract, the search
 *   attribute translation, eight optional overrides — which is a copy that
 *   drifts. A deploy changing one of those deletes the schedule and creates it.
 *
 * So: after this call the schedule FIRES when the arguments say, and RUNS what
 * they say.
 *
 * ```ts
 * await ensureSchedule(client.for(orderContract).schedule, "sweepStaleOrders", {
 *   scheduleId: "sweep-stale-orders",
 *   spec: { cronExpressions: ["0 3 * * *"] },
 *   args: [{ olderThanDays: 30 }],
 * });
 * ```
 */
export const ensureSchedule = <
  C extends ContractDefinition,
  W extends keyof C["workflows"] & string,
>(
  schedules: TypedScheduleClient<C>,
  workflow: W,
  options: TypedScheduleCreateOptions<C, W>,
): AsyncResult<
  ScheduleOutcome,
  WorkflowNotInContractError | WorkflowValidationError | ScheduleNotFoundError
> =>
  schedules
    .create(workflow, options)
    .map((): ScheduleOutcome => "created")
    .flatMapErrCases((matcher) =>
      matcher
        .with(P.tag(SCHEDULE_ALREADY_EXISTS_ERROR_TAG), () =>
          schedules
            .getHandle(options.scheduleId)
            .update((previous) => ({
              ...previous,
              spec: options.spec,
              action: { ...previous.action, workflowType: workflow, args: [options.args] },
              ...(options.policies === undefined ? {} : { policies: options.policies }),
            }))
            .map((): ScheduleOutcome => "updated"),
        )
        // Named rather than left to a wildcard: the matcher has none, so a
        // fourth error added upstream fails this file instead of being
        // silently recovered into a schedule nobody registered.
        .with(P.tag("@temporal-contract/WorkflowNotInContractError"), (error) => ErrAsync(error))
        .with(P.tag("@temporal-contract/WorkflowValidationError"), (error) => ErrAsync(error)),
    );
