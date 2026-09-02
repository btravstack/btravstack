import { Provider, type ServiceOf } from "@btravstack/di";
import { MalformedCursor, OrderRepository, page } from "@btravstack/example-order-application";
import {
  DuplicateOrder,
  Order,
  OrderNotFound,
  type OrderId,
} from "@btravstack/example-order-domain";
import { all, Err, P, type Result } from "unthrown";

import { OrderDatabase, type OrderDatabaseClient } from "./database.js";

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
 * The translation this whole layer exists for. Prisma's three tagged P-codes are
 * each named, because `mapErrCases` has no wildcard to hide behind: only the
 * duplicate has a meaning the application shares — the composite
 * `(tenantId, orderId)` one, so two tenants may hold the same order id — and the
 * other two describe a schema this adapter does not have, so reaching them is a
 * bug rather than a request.
 *
 * Adding a fourth P-code upstream breaks this file and nothing downstream, which
 * is the point: infrastructure vocabulary stops here.
 */
export const prismaOrderRepository = (db: OrderDatabaseClient): ServiceOf<OrderRepository> => ({
  // The transactional-outbox write: the row and the fact of the row commit
  // together or not at all, so there is no second bookkeeping path for the
  // event to miss. The payload is what makes it a create-or-replace; its
  // tombstone twin is in `remove`.
  save: (tenantId, order) =>
    db
      .$tryTransaction((tx) =>
        tx.order
          .tryCreate({ data: { tenantId, orderId: order.id, quantity: order.quantity } })
          .flatMap(() =>
            tx.outboxMessage.tryCreate({
              data: {
                tenantId,
                kind: "order",
                subjectId: order.id,
                payload: JSON.stringify({ quantity: order.quantity }),
              },
            }),
          ),
      )
      .mapErrCases((matcher, defect) =>
        matcher
          .with(P.tag("UniqueConstraintViolation"), () => new DuplicateOrder({ id: order.id }))
          .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
          .with(P.tag("RecordNotFound"), (missing) => defect(missing)),
      )
      .map(() => order),

  find: (tenantId, id) =>
    db.order
      .tryFindUnique({ where: { tenantId_orderId: { tenantId, orderId: id } } })
      .flatMap((row) =>
        row === null ? Err(new OrderNotFound({ id: id as OrderId })) : hydrate(row),
      ),

  /**
   * The listing, and the one place this repository does not write its own
   * pagination. `@unthrown/prisma`'s `tryPaginate(...).withCursor(...)` owns the
   * cursor arithmetic — including the off-by-one this example would otherwise
   * have shipped, where a cursor pointing at a row the filter no longer matches
   * skips the first element of the page.
   *
   * `InvalidCursor` is its ONLY modeled failure, and translating it into the
   * application's `MalformedCursor` is the same move as `UniqueConstraintViolation`
   * into `DuplicateOrder` two methods up: the library's vocabulary stops here.
   * The cursor travels on the application's error because the library's carries
   * only a `cause` — and the value a 400 has to name is the string the caller
   * sent.
   *
   * The library keeps the flags and `startCursor`/`endCursor` apart — a LAST
   * page has a non-null `endCursor` — and `page` is where the two become one
   * fact: a side with no cursor is a side the caller cannot reach, so handing
   * the pair over unfolded (a cursor that returns nothing, or a flag with
   * nothing to follow) is not a page this layer can express.
   *
   * `before` pages BACKWARD and hands the rows back in the query's own order, so
   * the previous page reads the way the next one does. The two cursors are
   * exclusive in the port's type, which is the library's rule as well: a page
   * runs in one direction.
   */
  list: (tenantId, { limit, after, before, minQuantity }) =>
    db.order
      .tryPaginate({
        where: {
          tenantId,
          ...(minQuantity === undefined ? {} : { quantity: { gte: minQuantity } }),
        },
        orderBy: { id: "asc" },
      })
      .withCursor(
        before === undefined
          ? { limit, ...(after === undefined ? {} : { after }) }
          : { limit, before },
      )
      .mapErrCases((matcher) =>
        matcher.with(
          P.tag("InvalidCursor"),
          () => new MalformedCursor({ cursor: before ?? after ?? "" }),
        ),
      )
      .flatMap(([rows, meta]) =>
        all(rows.map(hydrate)).map((items) =>
          page(items, {
            previous: meta.hasPreviousPage ? meta.startCursor : null,
            next: meta.hasNextPage ? meta.endCursor : null,
          }),
        ),
      ),

  // Compensation's persistence arm. `delete`, not `deleteMany`: `tryDelete`
  // puts P2025 in the error channel as `RecordNotFound`, which is the domain's
  // `OrderNotFound` under another vocabulary, where counting a batch would
  // hand-roll what the library already models.
  //
  // It emits a **tombstone** — an event with no payload — in the same
  // transaction, because "the row went but the news did not" is the failure the
  // outbox exists to make impossible. Nothing is written when there was nothing
  // to delete: the transaction rolls back before the insert, so a re-run of
  // `cancelPlacement` cannot append a second tombstone.
  remove: (tenantId, id) =>
    db
      .$tryTransaction((tx) =>
        tx.order.tryDelete({ where: { tenantId_orderId: { tenantId, orderId: id } } }).flatMap(() =>
          tx.outboxMessage.tryCreate({
            data: { tenantId, kind: "order", subjectId: id, payload: null },
          }),
        ),
      )
      .map(() => undefined)
      .mapErrCases((matcher, defect) =>
        matcher
          .with(P.tag("RecordNotFound"), () => new OrderNotFound({ id: id as OrderId }))
          // No relation to violate in this schema; reaching it is a bug.
          .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
          .with(P.tag("UniqueConstraintViolation"), (clash) => defect(clash)),
      ),
});

export const orderRepositoryProvider = Provider(OrderRepository)({
  inject: { db: OrderDatabase },
  sync: ({ db }) => prismaOrderRepository(db),
});
