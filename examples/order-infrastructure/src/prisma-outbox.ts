import { Provider, type ServiceOf } from "@btravstack/di";
import { Outbox } from "@btravstack/example-order-application";
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
 * Scoped to the tenant the caller names, like every other read in this layer.
 *
 * Ordered by `id` so the relay publishes in commit order; filtered on
 * `publishedAt: null` so a crash between publish and mark re-delivers rather
 * than loses — the outbox trades exactly-once for at-least-once on purpose,
 * and the consumer's idempotency is where that trade is honoured.
 */
export const prismaOutbox = (db: OrderDatabaseClient): ServiceOf<Outbox> => ({
  pending: (tenantId, limit) =>
    db.outboxMessage
      .tryFindMany({
        where: { tenantId, publishedAt: null },
        orderBy: { id: "asc" },
        take: limit,
      })
      .map((rows) =>
        rows.map((row) => ({
          id: row.id,
          // Echoed back rather than assumed from the query: the relay puts it
          // on the event it publishes, which is how the tenant crosses the
          // broker to a subscriber in another process.
          tenantId: row.tenantId,
          // The column is a `string`; the port's `kind` is the union of the
          // kinds this application emits, and `save`/`remove` are the only
          // writers. A row carrying anything else was not written by this
          // code, so the narrowing is a claim the adapter is entitled to make.
          kind: row.kind as "order",
          subjectId: row.subjectId,
          occurredAt: row.occurredAt,
          // A NULL payload is the tombstone, and it stays null all the way to
          // the wire. `JSON.parse` on a row this code wrote cannot fail; if it
          // somehow does, the throw becomes a Defect — which is the honest
          // channel for "the database contains something impossible".
          payload:
            row.payload === null
              ? null
              : (JSON.parse(row.payload) as { readonly quantity: number }),
        })),
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

export const outboxProvider = Provider(Outbox)(
  { db: OrderDatabase },
  { sync: ({ db }) => prismaOutbox(db) },
);
