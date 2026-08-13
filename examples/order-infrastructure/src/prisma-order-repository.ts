import { Provider, type ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/start-example-order-application";
import { DuplicateOrder, Order, OrderNotFound } from "@btravstack/start-example-order-domain";
import { Err, Ok, P, type Result } from "unthrown";

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
  save: (order) =>
    db
      .$tryTransaction((tx) =>
        tx.order
          .tryCreate({ data: { orderId: order.id, quantity: order.quantity } })
          .flatMap(() =>
            tx.outboxMessage.tryCreate({ data: { orderId: order.id, quantity: order.quantity } }),
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

  // Compensation's persistence arm. `deleteMany` rather than `delete` so a
  // missing row is a countable outcome instead of a P2025: compensating a
  // placement that never landed answers `OrderNotFound`, a value the saga can
  // ignore on purpose. The outbox row, if the placement committed one, stays —
  // the broadcast says what happened, and a cancellation is a *further* fact,
  // not an eraser (`order.cancelled` is the reader's exercise).
  remove: (id) =>
    db.order
      .tryDeleteMany({ where: { orderId: id } })
      .mapErrCases((matcher, defect) =>
        // This schema has no relation to violate; reaching it is a bug.
        matcher.with(P.tag("ForeignKeyViolation"), (violation) => defect(violation)),
      )
      .flatMap((batch) => (batch.count === 0 ? Err(new OrderNotFound({ id })) : Ok())),
});

export const orderRepositoryProvider = Provider(OrderRepository)([OrderDatabase], {
  sync: prismaOrderRepository,
});
