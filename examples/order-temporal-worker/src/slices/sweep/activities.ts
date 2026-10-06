import type { ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/example-order-application";
import { orderContract } from "@btravstack/example-order-temporal-contract";
import { TemporalWorkflowActivities } from "@btravstack/temporal-worker";
import { OkAsync, P, type AsyncResult } from "unthrown";

/** When an order was placed, read off its id: a UUIDv7's first 48 bits are its Unix milliseconds. */
const placedAt = (id: string): number => Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);

const PAGE = 100;

/**
 * Every stale id, collected BEFORE anything is removed: a keyset walk resumes
 * from a row on the previous page, so deleting while walking would pull that
 * row out from under the next seek.
 */
const staleOrders = (
  repository: ServiceOf<OrderRepository>,
  placedBefore: number,
  after?: string,
): AsyncResult<readonly string[], never> =>
  repository
    .list({ limit: PAGE, sort: { field: "quantity", direction: "asc" }, after })
    // Both cursors were minted by this store one page ago, so a refusal is a
    // bug rather than an answer — and a defect is what Temporal retries.
    .mapErrCases((matcher, defect) =>
      matcher.with(P.tag("MalformedCursor"), P.tag("CursorSortMismatch"), (error) => defect(error)),
    )
    .flatMap((page) => {
      const stale = page.items.map((order) => order.id).filter((id) => placedAt(id) < placedBefore);
      return page.hasNextPage
        ? staleOrders(repository, placedBefore, page.nextCursor).map((rest) => [...stale, ...rest])
        : OkAsync(stale);
    });

/**
 * Withdraw every order placed before `placedBefore`, answering how many. Each
 * removal leaves its tombstone in the outbox, so the broadcast deployment
 * tells every subscriber the order is gone — housekeeping is just another
 * write.
 *
 * `OrderNotFound` is absorbed for `cancelPlacement`'s reason: a retried sweep
 * meets the orders its first attempt already removed, and has to answer the
 * same both times.
 */
export const withdrawStale = (
  repository: ServiceOf<OrderRepository>,
  placedBefore: number,
): AsyncResult<{ readonly withdrawn: number }, never> =>
  staleOrders(repository, placedBefore).flatMap((ids) =>
    ids
      .reduce<AsyncResult<void, never>>(
        (removed, id) =>
          removed.flatMap(() =>
            repository
              .remove(id)
              .recoverErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => undefined)),
          ),
        OkAsync(),
      )
      .map(() => ({ withdrawn: ids.length })),
  );

/**
 * The sweep's one activity, over the repository the attempt's fork bound to
 * the tenant the schedule named.
 */
export const sweepStaleOrders = TemporalWorkflowActivities(
  orderContract,
  "sweepStaleOrders",
)({
  inject: {},
  unit: { repository: OrderRepository },
  sync: () => ({
    withdrawStaleOrders: ({ context, input }) =>
      withdrawStale(context.unit.repository, input.placedBefore),
  }),
});
