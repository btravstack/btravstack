import { page } from "@btravstack/contract";
import { type ServiceOf } from "@btravstack/di";
import { MalformedCursor, type OrderRepository } from "@btravstack/example-order-application";
import {
  DuplicateOrder,
  Order,
  OrderNotFound,
  type OrderId,
  type TenantId,
} from "@btravstack/example-order-domain";
import { tenantPinned } from "@btravstack/prisma/rls";
import { all, Err, Ok, P, type Result } from "unthrown";

import type { OrderDatabaseClient, OrderTransaction } from "./database.js";

type OrderRow = { readonly orderId: string; readonly quantity: number };

/**
 * Rebuilding the entity re-runs its invariants, so a stored row that violates
 * them cannot become an `Order`. Not a domain outcome — nothing the caller did
 * produced it — so it goes to the defect channel, which is why `find` can
 * promise `OrderNotFound` and nothing else.
 */
const hydrate = (row: OrderRow): Result<Order, never> =>
  Order.make({ id: row.orderId, quantity: row.quantity }).mapErrCases((matcher, defect) =>
    matcher.with(P.tag("InvalidEntity"), (invalid) => defect(invalid)),
  );

/**
 * A cursor is the `id` the keyset resumes from, as a string on the wire.
 *
 * Opaque to the caller and numeric underneath, which is the one place this
 * adapter's storage shows through — so decoding is where a caller's garbage
 * becomes the application's `MalformedCursor` rather than a `NaN` that pages
 * from nowhere.
 */
const cursorOf = (row: { readonly id: number }): string => String(row.id);
const decodeCursor = (cursor: string): Result<number, MalformedCursor> => {
  const id = Number(cursor);
  return Number.isSafeInteger(id) ? Ok(id) : Err(new MalformedCursor({ cursor }));
};

/**
 * The translation this whole layer exists for. The database's own SQLSTATEs
 * arrive tagged — `@btravstack/prisma/result` maps them — and each is named
 * here, because `mapErrCases` has no wildcard to hide behind: only the
 * duplicate has a meaning the application shares (the composite
 * `(tenantId, orderId)` one, so two tenants may hold the same order id), and
 * the other two describe a database this adapter should never provoke.
 *
 * `NotAuthorized` is SQLSTATE 42501 — the row-security policy refusing a write
 * that would land under another tenant. It is a defect because this adapter
 * closes over one tenant and writes that tenant's column: reaching it means
 * the pin and the row disagree, which is a bug rather than a request.
 *
 * Adding a fourth SQLSTATE upstream breaks this file and nothing downstream,
 * which is the point: infrastructure vocabulary stops here.
 *
 * The tenant is bound once, at construction, and every statement below closes
 * over it — so the port has no parameter a caller could name another tenant in.
 * Each method runs inside `tenantPinned`, which opens the transaction the pin
 * is local to; the policy is what the database then enforces.
 */
export const prismaOrderRepository = (
  db: OrderDatabaseClient,
  tenantId: TenantId,
): ServiceOf<OrderRepository> => {
  const pinned = <R>(work: (tx: OrderTransaction) => PromiseLike<R>) =>
    tenantPinned(db, tenantId, work);

  return {
    // The transactional-outbox write: the row and the fact of the row commit
    // together or not at all, so there is no second bookkeeping path for the
    // event to miss. The payload is what makes it a create-or-replace; its
    // tombstone twin is in `remove`. The pin rides the SAME transaction, which
    // is what `tenantPinned` exists to guarantee.
    save: (order) =>
      pinned(async (tx) => {
        await tx.orm.public.Order.create({
          tenantId,
          orderId: order.id,
          quantity: order.quantity,
        });
        await tx.orm.public.OutboxMessage.create({
          tenantId,
          kind: "order",
          subjectId: order.id,
          payload: JSON.stringify({ quantity: order.quantity }),
        });
      })
        .mapErrCases((matcher, defect) =>
          matcher
            .with(P.tag("UniqueConstraintViolation"), () => new DuplicateOrder({ id: order.id }))
            .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
            .with(P.tag("NotAuthorized"), (refused) => defect(refused)),
        )
        .map(() => order),

    find: (id) =>
      pinned((tx) => tx.orm.public.Order.where({ tenantId, orderId: id }).first())
        .mapErrCases((matcher, defect) =>
          matcher.with(
            P.tag("UniqueConstraintViolation"),
            P.tag("ForeignKeyViolation"),
            P.tag("NotAuthorized"),
            (e) => defect(e),
          ),
        )
        .flatMap((row) =>
          row === null ? Err(new OrderNotFound({ id: id as OrderId })) : hydrate(row),
        ),

    /**
     * The listing. Prisma 8's own keyset cursor does the arithmetic —
     * `.orderBy(...).cursor({ id }).limit(n)` resumes strictly after the row the
     * cursor names — so the off-by-one this example would otherwise have
     * shipped is the ORM's problem rather than this file's.
     *
     * What stays here is the part that is the application's: one extra row is
     * fetched to learn whether another page exists, and `page` folds the flag
     * and the cursor into one fact, because a side with no cursor is a side the
     * caller cannot reach.
     *
     * `before` pages BACKWARD — descending from the cursor — and the rows are
     * handed back in the query's own ascending order, so the previous page
     * reads the way the next one does. The two cursors are exclusive in the
     * port's type: a page runs in one direction.
     */
    list: ({ limit, after, before, minQuantity }) => {
      const from = before ?? after;
      const start = from === undefined ? Ok(undefined) : decodeCursor(from);
      return start.toAsync().flatMap((cursor) =>
        pinned(async (tx) => {
          // No `tenantId` filter: the policy on `Order` holds it, and a filter
          // here would hide whether it does.
          const base =
            minQuantity === undefined
              ? tx.orm.public.Order
              : tx.orm.public.Order.where((order) => order.quantity.gte(minQuantity));
          const ordered =
            before === undefined
              ? base.orderBy((order) => order.id.asc())
              : base.orderBy((order) => order.id.desc());
          const seeked = cursor === undefined ? ordered : ordered.cursor({ id: cursor });
          // One more than asked for: the extra row is how a page learns there
          // is another, without a second count query.
          return seeked.limit(limit + 1).all();
        })
          .mapErrCases((matcher, defect) =>
            matcher.with(
              P.tag("UniqueConstraintViolation"),
              P.tag("ForeignKeyViolation"),
              P.tag("NotAuthorized"),
              (e) => defect(e),
            ),
          )
          .flatMap((fetched) => {
            const more = fetched.length > limit;
            const window = more ? fetched.slice(0, limit) : fetched;
            const rows = before === undefined ? window : [...window].reverse();
            return all(rows.map(hydrate)).map((items) =>
              page(items, {
                previous:
                  before === undefined
                    ? after === undefined
                      ? null
                      : rows[0] === undefined
                        ? null
                        : cursorOf(rows[0])
                    : more
                      ? rows[0] === undefined
                        ? null
                        : cursorOf(rows[0])
                      : null,
                next:
                  before === undefined
                    ? more
                      ? rows.at(-1) === undefined
                        ? null
                        : cursorOf(rows.at(-1)!)
                      : null
                    : rows.at(-1) === undefined
                      ? null
                      : cursorOf(rows.at(-1)!),
              }),
            );
          }),
      );
    },

    /**
     * Compensation's persistence arm. `.delete()` answers the row it removed, or
     * `null` when the predicate matched nothing — Prisma 8 models a missing row
     * as an absence rather than an error, so "there was nothing to delete" is a
     * branch here rather than an arm of the error channel.
     *
     * It emits a **tombstone** — an event with no payload — in the same
     * transaction, because "the row went but the news did not" is the failure
     * the outbox exists to make impossible. Nothing is written when there was
     * nothing to delete: the `Err` is returned before the insert, which rolls
     * the transaction back, so a re-run of `cancelPlacement` cannot append a
     * second tombstone.
     */
    remove: (id) =>
      pinned(async (tx) => {
        const deleted = await tx.orm.public.Order.where({ tenantId, orderId: id }).delete();
        if (deleted === null) return false;
        await tx.orm.public.OutboxMessage.create({
          tenantId,
          kind: "order",
          subjectId: id,
          payload: null,
        });
        return true;
      })
        .mapErrCases((matcher, defect) =>
          // No relation to violate in this schema, and the pin is this
          // adapter's own: reaching either is a bug.
          matcher.with(
            P.tag("UniqueConstraintViolation"),
            P.tag("ForeignKeyViolation"),
            P.tag("NotAuthorized"),
            (e) => defect(e),
          ),
        )
        .flatMap((removed) =>
          removed ? Ok(undefined) : Err(new OrderNotFound({ id: id as OrderId })),
        ),
  };
};
