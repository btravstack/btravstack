import { currentUnit } from "@btravstack/core";
import type { ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/example-order-application";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalWorkflowActivities } from "@btravstack/temporal-worker";
import { OkAsync, P, fromSafePromise, type AsyncResult } from "unthrown";

const BATCH = 100;

/**
 * Withdraw every order the store recorded as placed before `placedBefore`, a
 * batch at a time. Each removal leaves its tombstone in the outbox, so the
 * broadcast deployment tells every subscriber the order is gone.
 *
 * It answers nothing: a count would not survive a retried attempt, whose scan
 * no longer sees what the first attempt removed. `signal` is the unit's own —
 * once it aborts, the sweep stops before the next batch and fails as a
 * defect, so Temporal retries the attempt elsewhere rather than this process
 * deleting past the deadline it was given.
 */
export const withdrawStale = (
  repository: ServiceOf<OrderRepository>,
  placedBefore: Date,
  signal: AbortSignal | undefined,
): AsyncResult<void, never> =>
  signal?.aborted === true
    ? fromSafePromise(
        Promise.reject(new Error("the drain deadline passed before the sweep finished")),
      )
    : repository
        // Always the FIRST page of what is still stale: each batch removes
        // what the previous one answered, so there is no cursor to outlive.
        .list({ limit: BATCH, sort: { field: "quantity", direction: "asc" }, placedBefore })
        .mapErrCases((matcher, defect) =>
          matcher.with(P.tag("MalformedCursor"), P.tag("CursorSortMismatch"), (error) =>
            defect(error),
          ),
        )
        .flatMap((page) =>
          page.items.length === 0
            ? OkAsync()
            : page.items
                .reduce<AsyncResult<void, never>>(
                  (removed, order) =>
                    removed.flatMap(() =>
                      repository
                        .remove(order.id, { placedBefore })
                        .recoverErrCases((matcher) =>
                          matcher.with(P.tag("OrderNotFound"), () => undefined),
                        ),
                    ),
                  OkAsync(),
                )
                .flatMap(() => withdrawStale(repository, placedBefore, signal)),
        );

/** The sweep's one activity, over the repository the attempt's fork bound to the schedule's tenant. */
export const sweepStaleOrders = TemporalWorkflowActivities(
  orderContract,
  "sweepStaleOrders",
)({
  inject: {},
  unit: { repository: OrderRepository },
  sync: () => ({
    withdrawStaleOrders: ({ context, input }) =>
      withdrawStale(context.unit.repository, new Date(input.placedBefore), currentUnit()?.signal),
  }),
});
