import { keyset } from "@btravstack/contract";
import { type ServiceOf } from "@btravstack/di";
import {
  CursorSortMismatch,
  MalformedCursor,
  type OrderQuery,
  type OrderRepository,
} from "@btravstack/example-order-application";
import {
  DuplicateOrder,
  Order,
  OrderNotFound,
  type OrderId,
  type TenantId,
} from "@btravstack/example-order-domain";
import { tenantPinned } from "@btravstack/prisma/rls";
import { all, Err, ErrAsync, Ok, P, type Result } from "unthrown";

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
 * Which column a sortable field is stored in, exhaustive over the listing's own
 * vocabulary: a key the application declares sortable with no column here is a
 * compile error, never a page quietly ordered by something else.
 */
const sortColumn: Record<OrderQuery["sort"]["field"], "quantity"> = { quantity: "quantity" };

/**
 * A cursor carries the sort key's value and the surrogate `id` that breaks its
 * ties, as two strings on the wire.
 *
 * Opaque to the caller and numeric underneath, which is the one place this
 * adapter's storage shows through — so decoding is where a caller's garbage
 * becomes the application's `MalformedCursor` rather than a `NaN` that pages
 * from nowhere.
 */
const decodeCursor = (
  cursor: readonly [string, string],
): Result<{ readonly value: number; readonly id: number }, MalformedCursor> => {
  const [value, id] = [Number(cursor[0]), Number(cursor[1])];
  return Number.isSafeInteger(value) && Number.isSafeInteger(id)
    ? Ok({ value, id })
    : Err(new MalformedCursor({ cursor: cursor.join("|") }));
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
        await tx.orm.orders.Order.create({
          tenantId,
          orderId: order.id,
          quantity: order.quantity,
        });
        await tx.orm.orders.OutboxMessage.create({
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
      pinned((tx) => tx.orm.orders.Order.where({ tenantId, orderId: id }).first())
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
     * The listing, and what is left of it is the three decisions this
     * application owns: the tenant filter's absence, the ORM's own seek call,
     * and the translation of a bad cursor.
     *
     * Everything else is `keyset` — the over-fetch, the direction, the trim and
     * both cursors — because none of that is Prisma's or this application's. It
     * is the same arithmetic against every store, and it is where the
     * off-by-ones live.
     */
    list: ({ minQuantity, ...request }) => {
      const keys = keyset(request);
      if (!keys.resumable)
        return keys.reason === "malformed"
          ? ErrAsync(new MalformedCursor({ cursor: keys.cursor }))
          : ErrAsync(new CursorSortMismatch({ cursor: keys.cursor }));
      const column = sortColumn[keys.sort.field];
      const start = keys.cursor === undefined ? Ok(undefined) : decodeCursor(keys.cursor);
      return start.toAsync().flatMap((cursor) =>
        pinned(async (tx) => {
          // No `tenantId` filter: the policy on `Order` holds it, and a filter
          // here would hide whether it does.
          const base =
            minQuantity === undefined
              ? tx.orm.orders.Order
              : tx.orm.orders.Order.where((order) => order.quantity.gte(minQuantity));
          // A backward page walks the index the other way, so the direction is
          // the caller's sort flipped by the direction of travel — and BOTH
          // columns flip together, or the tiebreak disagrees with the key it
          // breaks.
          const descending = (keys.sort.direction === "desc") !== keys.backward;
          const ordered = descending
            ? base.orderBy([(order) => order[column].desc(), (order) => order.id.desc()])
            : base.orderBy([(order) => order[column].asc(), (order) => order.id.asc()]);
          // Every ordering column gets a value: a partial cursor seeks on one
          // column and silently skips the rows that tie on it. `.cursor(...)`
          // then resumes strictly AFTER the row it names, in whichever
          // direction the `orderBy` set — so the exclusivity is the ORM's, and
          // nothing here compensates for it.
          const seeked =
            cursor === undefined
              ? ordered
              : ordered.cursor({ [column]: cursor.value, id: cursor.id });
          return seeked.limit(keys.take).all();
        })
          .mapErrCases((matcher, defect) =>
            matcher.with(
              P.tag("UniqueConstraintViolation"),
              P.tag("ForeignKeyViolation"),
              P.tag("NotAuthorized"),
              (e) => defect(e),
            ),
          )
          .flatMap((fetched) =>
            all(fetched.map((row) => hydrate(row).map((order) => ({ row, order })))).map((rows) =>
              keys.page(
                rows,
                ({ row }) => [String(row[column]), String(row.id)],
                ({ order }) => order,
              ),
            ),
          ),
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
        const deleted = await tx.orm.orders.Order.where({ tenantId, orderId: id }).delete();
        if (deleted === null) return false;
        await tx.orm.orders.OutboxMessage.create({
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
