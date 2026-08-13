import { Provider, type ServiceOf } from "@btravstack/di";
import { Outbox } from "@btravstack/start-example-order-application";
import { P } from "unthrown";

import { OrderDatabase, type OrderDatabaseClient } from "./database.js";

/**
 * The outbox's read side. The write side lives inside
 * `prismaOrderRepository.save` — same transaction as the order row, which is
 * the entire pattern — so this adapter only ever pulls and marks.
 *
 * Both operations promise `never`: the port declares that a database that will
 * not answer is a defect, and this adapter keeps that promise by not
 * `mapErrCases`-ing anything into `E` — `tryFindMany` / `tryUpdateMany` carry
 * only `DriverError`, which the safe boundary would defect anyway.
 *
 * Ordered by `id` so the relay publishes in commit order; filtered on
 * `publishedAt: null` so a crash between publish and mark re-delivers rather
 * than loses — the outbox trades exactly-once for at-least-once on purpose,
 * and the consumer's idempotency is where that trade is honoured.
 */
export const prismaOutbox = (db: OrderDatabaseClient): ServiceOf<Outbox> => ({
  pending: (limit) =>
    db.outboxMessage
      .tryFindMany({ where: { publishedAt: null }, orderBy: { id: "asc" }, take: limit })
      .map((rows) =>
        rows.map((row) => ({ id: row.id, orderId: row.orderId, quantity: row.quantity })),
      )
      .mapErrCases((matcher, defect) => matcher.with(P.tag("DriverError"), (e) => defect(e))),

  markPublished: (ids) =>
    db.outboxMessage
      .tryUpdateMany({ where: { id: { in: [...ids] } }, data: { publishedAt: new Date() } })
      .map(() => undefined)
      .mapErrCases((matcher, defect) =>
        // No relation to violate, no unique column touched, and a driver that
        // will not answer is infrastructure: every arm is a bug by this
        // schema's lights, so all three keep the port's `never` honest.
        matcher.with(
          P.tag("DriverError"),
          P.tag("ForeignKeyViolation"),
          P.tag("UniqueConstraintViolation"),
          (e) => defect(e),
        ),
      ),
});

export const outboxProvider = Provider(Outbox)([OrderDatabase], {
  sync: prismaOutbox,
});
