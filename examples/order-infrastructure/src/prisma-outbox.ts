import { Provider, type ServiceOf } from "@btravstack/di";
import { Outbox } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { P } from "unthrown";

import { OrderDatabase, type OrderDatabaseClient } from "./database.js";

/**
 * The outbox's read side. The write side lives inside
 * `prismaOrderRepository.save`, in the same transaction as the order row — the
 * entire pattern — so this adapter only pulls and marks.
 *
 * Both operations promise `never`, which they keep by mapping nothing into `E`:
 * the port declares that a database which will not answer is a defect.
 *
 * Ordered by `id` so the relay publishes in commit order, and filtered on
 * `publishedAt: null` so a crash between publish and mark re-delivers rather
 * than loses. The outbox trades exactly-once for at-least-once on purpose.
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
          // The one read-back in the system, and so the one place the brand is
          // re-applied: every value in this column was written by a call that
          // named a `TenantId`.
          tenantId: TenantId(row.tenantId),
          // `save`/`remove` are the only writers, so a row carrying another
          // kind was not written by this code.
          kind: row.kind as "order",
          subjectId: row.subjectId,
          occurredAt: row.occurredAt,
          // A NULL payload is the tombstone and stays null to the wire.
          // `JSON.parse` on a row this code wrote cannot fail; if it somehow
          // does, the throw becomes a Defect, which is the honest channel for
          // "the database contains something impossible".
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
        // No relation to violate and no unique column touched: every arm is a
        // bug by this schema's lights, so all three keep the port's `never`.
        matcher.with(
          P.tag("DriverError"),
          P.tag("ForeignKeyViolation"),
          P.tag("UniqueConstraintViolation"),
          (e) => defect(e),
        ),
      ),
});

export const outboxProvider = Provider(Outbox)({
  inject: { db: OrderDatabase },
  sync: ({ db }) => prismaOutbox(db),
});
