import { Provider, type ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/example-order-application";
import { DuplicateOrder, Order, OrderNotFound } from "@btravstack/example-order-domain";
import { Err, P, type Result } from "unthrown";

import { OrderDatabase, type OrderDatabaseClient } from "./database.js";

type OrderRow = { readonly orderId: string; readonly quantity: number };

/**
 * Rebuilding the entity re-runs its invariants, so a stored row that violates
 * them cannot become an `Order`. That is not a domain outcome — nothing the
 * caller did produced it and nothing they can do recovers from it — so it goes
 * to the defect channel rather than into `E`, which is why `find` can promise
 * `OrderNotFound` and nothing else.
 */
const hydrate = (row: OrderRow): Result<Order, never> =>
  Order.make({ id: row.orderId, quantity: row.quantity }).mapErrCases((matcher, defect) =>
    matcher.with(P.tag("InvalidEntity"), (invalid) => defect(invalid)),
  );

/**
 * The translation this whole layer exists for. `tryCreate`'s error channel is
 * Prisma's vocabulary — three tagged P-codes — and every one of them is named
 * here, because `mapErrCases` has no wildcard to hide behind. Only the
 * duplicate has a meaning the application shares; the other two describe a
 * schema this adapter does not have (there is no relation to violate, and
 * `create` has no row of its own to miss), so reaching them means something is
 * wrong with the code, not with the request — the defect channel, not `E`.
 *
 * Adding a fourth P-code upstream breaks this file and nothing downstream,
 * which is the point: infrastructure vocabulary stops here.
 */
export const prismaOrderRepository = (db: OrderDatabaseClient): ServiceOf<OrderRepository> => ({
  // The transactional-outbox write: the row and the fact of the row commit
  // together or not at all. `$tryTransaction`'s callback speaks `AsyncResult`,
  // so a failed insert rolls the pair back and surfaces as the same value it
  // would have been alone — no second bookkeeping path for the event to miss.
  //
  // The event carries a payload, which is what makes it a create-or-replace
  // for its subject. Its tombstone twin is in `remove`.
  save: (order) =>
    db
      .$tryTransaction((tx) =>
        tx.order.tryCreate({ data: { orderId: order.id, quantity: order.quantity } }).flatMap(() =>
          tx.outboxMessage.tryCreate({
            data: {
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

  find: (id) =>
    db.order
      .tryFindUnique({ where: { orderId: id } })
      .flatMap((row) => (row === null ? Err(new OrderNotFound({ id })) : hydrate(row))),

  // Compensation's persistence arm — `delete`, not `deleteMany`, because
  // `orderId` carries the UNIQUE index and this deletes exactly one row.
  // Counting a batch to discover the row was missing would be hand-rolling
  // what the library already models: `tryDelete` puts P2025 in the error
  // channel as `RecordNotFound`, which is precisely the domain's
  // `OrderNotFound` under another vocabulary. Compensating a placement that
  // never landed therefore answers a value the saga can ignore on purpose.
  //
  // It emits a **tombstone** — an event with no payload — in the same
  // transaction as the delete, for the same reason `save` emits its event
  // there: a subscriber that learned an order exists must learn it is gone,
  // and "the row went but the news did not" is precisely the failure the
  // outbox exists to make impossible. The earlier events for this subject are
  // left alone; the log is a history, and the tombstone is its last word.
  //
  // Nothing is written when there was nothing to delete: `tryDelete` fails
  // with `RecordNotFound` before the insert, and the transaction rolls back —
  // so a re-run of the saga's `cancelPlacement` cannot append a second
  // tombstone for an order already gone.
  remove: (id) =>
    db
      .$tryTransaction((tx) =>
        tx.order.tryDelete({ where: { orderId: id } }).flatMap(() =>
          tx.outboxMessage.tryCreate({
            data: { kind: "order", subjectId: id, payload: null },
          }),
        ),
      )
      .map(() => undefined)
      .mapErrCases((matcher, defect) =>
        matcher
          .with(P.tag("RecordNotFound"), () => new OrderNotFound({ id }))
          // No relation to violate in this schema; reaching it is a bug.
          .with(P.tag("ForeignKeyViolation"), (violation) => defect(violation))
          .with(P.tag("UniqueConstraintViolation"), (clash) => defect(clash)),
      ),
});

export const orderRepositoryProvider = Provider(OrderRepository)([OrderDatabase], {
  sync: prismaOrderRepository,
});
