import { Provider, type ServiceOf } from "@btravstack/di";
import { Outbox } from "@btravstack/example-order-application";
import { TenantId } from "@btravstack/example-order-domain";
import { tryQuery } from "@btravstack/prisma/result";
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
    tryQuery(() =>
      // `OutboxMessage` carries no policy — the relay reads it across tenants
      // on an unpinned client — so this `tenantId` is what holds the tenant,
      // not a leftover of the one `prisma-order-repository`'s `list` dropped.
      // "does not hand one tenant another's pending events" is what catches
      // its removal.
      db.orm.public.OutboxMessage.where({ tenantId })
        .where((message) => message.publishedAt.isNull())
        .orderBy((message) => message.id.asc())
        .limit(limit)
        .all(),
    )
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
          // The column is `TimestamptzString`, so it arrives as PostgreSQL's
          // own text. A `Timestamptz` would arrive as a `Temporal.Instant` and
          // need `globalThis.Temporal`, which no Node this repository supports
          // ships — see the contract's own note. The port speaks `Date`, so
          // this is where the text becomes one.
          occurredAt: new Date(row.occurredAt),
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
      .mapErrCases((matcher, defect) =>
        matcher.with(
          P.tag("UniqueConstraintViolation"),
          P.tag("ForeignKeyViolation"),
          P.tag("NotAuthorized"),
          (e) => defect(e),
        ),
      ),

  /**
   * One statement per id, in one transaction — **not** a predicate over
   * `id.in([...])`.
   *
   * Prisma 8's `.where(…).update(…)` updates a SINGLE row and answers it, the
   * way `findFirst` reads one: measured, an `id.in([1, 2, 3])` update marked
   * one row of three and reported success. There is no `updateMany`, and the
   * SQL builder's own predicate helpers carry no `IN`. So the batch is a loop,
   * and the transaction is what keeps it all-or-nothing.
   *
   * Leaving a row unmarked is not a small bug: the relay re-reads it on the
   * next sweep and publishes the event twice, which is what a subscriber sees
   * — it cost a duplicate tombstone in CI before this was understood. The
   * batch is bounded by the `limit` `pending` was called with.
   */
  markPublished: (ids) =>
    tryQuery(() =>
      db.transaction(async (tx) => {
        for (const id of ids) {
          await tx.orm.public.OutboxMessage.where({ id }).update({
            publishedAt: new Date().toISOString(),
          });
        }
      }),
    )
      .map(() => undefined)
      .mapErrCases((matcher, defect) =>
        // No relation to violate, no unique column touched and no policy on
        // this table: every arm is a bug by this schema's lights, so all three
        // keep the port's `never`.
        matcher.with(
          P.tag("UniqueConstraintViolation"),
          P.tag("ForeignKeyViolation"),
          P.tag("NotAuthorized"),
          (e) => defect(e),
        ),
      ),
});

export const outboxProvider = Provider(Outbox)({
  inject: { db: OrderDatabase },
  sync: ({ db }) => prismaOutbox(db),
});
