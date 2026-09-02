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
 * **`spec` is the only field reconciled**, and the rest of an existing
 * schedule is left as it stands. Two different reasons, and they are worth
 * telling apart:
 *
 * - **`state` is deliberately preserved.** A schedule an operator paused stays
 *   paused across a deploy, because unpausing it is a decision a person made
 *   and a deploy is not the place to reverse it.
 * - **`args` and the rest of the action are preserved because this cannot
 *   reconcile them SAFELY.** `create` validates `args` against the workflow's
 *   input schema; the handle's `update` takes Temporal's own
 *   `ScheduleUpdateOptions` and validates nothing, so writing them here would
 *   push unvalidated input at the server through a door the typed client keeps
 *   shut. A deploy that changes what a schedule RUNS — its args, its workflow,
 *   its policies — should say so explicitly: delete the schedule and create it,
 *   or reach `getHandle(id).update(...)` directly and own the shape.
 *
 * So: after this call the schedule FIRES when the arguments say. What it fires
 * with is whatever it already fired with.
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
            .update((previous) => ({ ...previous, spec: options.spec }))
            .map((): ScheduleOutcome => "updated"),
        )
        // Named rather than left to a wildcard: the matcher has none, so a
        // fourth error added upstream fails this file instead of being
        // silently recovered into a schedule nobody registered.
        .with(P.tag("@temporal-contract/WorkflowNotInContractError"), (error) => ErrAsync(error))
        .with(P.tag("@temporal-contract/WorkflowValidationError"), (error) => ErrAsync(error)),
    );
