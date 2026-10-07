import { fromSafePromise } from "unthrown";

import type { OutboxMessage, OutboxStoreService } from "./outbox.js";

/**
 * The little of a Prisma 8 client this store needs: the raw lane to build its
 * statements with, and `transaction` to run them in.
 */
export type OutboxDatabase<Tx> = {
  /**
   * Required to EXIST and not described further, for `@btravstack/prisma`'s
   * reason: the real tag takes the contract's own interpolation and row-spec
   * types, narrower than anything a package that cannot see a contract could
   * name, and a parameter is contravariant.
   */
  readonly raw: { readonly sql: unknown };
  readonly transaction: <R>(fn: (tx: Tx) => PromiseLike<R>) => Promise<R>;
};

/** Where the table lives. */
export type PrismaOutboxStoreOptions = {
  /** The namespace the model is declared in (default `public`). */
  readonly schema?: string;
  /** The table Prisma maps the model to (default `outboxMessage`, the table of a model named `OutboxMessage`). */
  readonly table?: string;
};

type Plan = { readonly build: () => unknown };

/** The store's own view of a client, reached by a cast for the reason on {@link OutboxDatabase}. */
type Raw = {
  readonly raw: {
    readonly sql: (
      strings: TemplateStringsArray,
      ...values: readonly string[]
    ) => {
      readonly returnsRow: (spec: Readonly<Record<string, string>>) => Plan;
      readonly affectedCount: () => Plan;
    };
  };
};

type Queryable = { readonly query: (plan: unknown) => PromiseLike<unknown> };

type Row = {
  readonly id: bigint;
  readonly tenantId: string;
  readonly kind: string;
  readonly subjectId: string;
  readonly payload: string | null;
  readonly occurredAt: string;
};

/**
 * An `int8` id as the number the port speaks, refused rather than rounded past
 * 2^53 — a row whose id cannot be named exactly would be marked, and
 * deduplicated on, as some other row.
 */
const safe = (id: bigint): number => {
  const value = Number(id);
  // oxlint-disable-next-line unthrown/no-throw -- the transaction callback is a Promise, and a rejection is the defect channel this store reports an impossible row on
  if (!Number.isSafeInteger(value)) throw new RangeError(`outbox id ${String(id)} exceeds 2^53`);
  return value;
};

const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** A template whose text carries the table's identifier — the one part a parameter cannot be. */
const statement = (...parts: readonly string[]): TemplateStringsArray =>
  Object.assign([...parts], { raw: [...parts] });

/**
 * The outbox store over a Prisma 8 client, in raw SQL against the documented
 * table — the model is the application's, declared in its own contract.
 *
 * **The claim is a transaction-scoped advisory lock per tenant**, taken with
 * `pg_try_advisory_xact_lock` before the batch is read: a relay that does not
 * get it skips the tenant, and the lock dies with the transaction, so a relay
 * that crashes mid-batch releases it with its connection. The batch is read,
 * published and marked inside that one transaction, so a mark that never
 * commits leaves its rows pending rather than lost. The cost is a pooled
 * connection held for the length of one batch's publishes.
 *
 * **One relay per tenant holds while its claiming session lives.** The claim
 * lifts `idle_in_transaction_session_timeout` for its own transaction, so a
 * configured timeout cannot end it mid-batch; a session the server ends any
 * other way (a terminated backend, a failover) frees the lock while the relay
 * is still publishing, and another relay may publish the same rows — which is
 * at-least-once delivery, deduplicated on the id.
 *
 * The table's `id` is a `BigInt` — an `Int` runs out at 2^31 — read through
 * `pg/int8@1` and refused, as a defect, past 2^53 rather than rounded.
 * `occurredAt` is read through `to_json`, which answers ISO 8601 whatever the
 * column's codec or the server's `DateStyle`, so the store needs no codec
 * beyond `pg/text@1` and `pg/int8@1` — both of which the table itself uses.
 */
export const prismaOutboxStore = <Tx>(
  db: OutboxDatabase<Tx>,
  options: PrismaOutboxStoreOptions = {},
): OutboxStoreService => {
  const schema = options.schema ?? "public";
  const table = options.table ?? "outboxMessage";
  const qualified = `${identifier(schema)}.${identifier(table)}`;
  const { sql } = (db as unknown as Raw).raw;

  // `idle_in_transaction_session_timeout` is lifted for this transaction alone:
  // the claim sits idle while the publisher works, and a server that ended the
  // session there would free the lock mid-batch for another relay to take.
  const lock = (tenantId: string) =>
    sql`SELECT set_config('idle_in_transaction_session_timeout', '0', true) AS lifted, pg_try_advisory_xact_lock(hashtext(${`${schema}.${table}`}), hashtext(${tenantId}))::text AS locked`
      .returnsRow({ lifted: "pg/text@1", locked: "pg/text@1" })
      .build();

  const select = (tenantId: string, limit: number) =>
    sql(
      statement(
        `SELECT "id", "tenantId", "kind", "subjectId", "payload", to_json("occurredAt") #>> '{}' AS "occurredAt" FROM ${qualified} WHERE "tenantId" = `,
        ` AND "publishedAt" IS NULL ORDER BY "id" LIMIT `,
        "::int",
      ),
      tenantId,
      String(limit),
    )
      .returnsRow({
        id: "pg/int8@1",
        tenantId: "pg/text@1",
        kind: "pg/text@1",
        subjectId: "pg/text@1",
        payload: "pg/text@1",
        occurredAt: "pg/text@1",
      })
      .build();

  // The tenants ride as one JSON array, so a tenant id carries no delimiter
  // the statement could split on.
  const oldest = (tenantIds: readonly string[]) =>
    sql(
      statement(
        `SELECT "tenantId", to_json(min("occurredAt")) #>> '{}' AS "occurredAt" FROM ${qualified} WHERE "publishedAt" IS NULL AND "tenantId" IN (SELECT json_array_elements_text(`,
        `::json)) GROUP BY "tenantId"`,
      ),
      JSON.stringify(tenantIds),
    )
      .returnsRow({ tenantId: "pg/text@1", occurredAt: "pg/text@1" })
      .build();

  const mark = (ids: readonly number[]) =>
    sql(
      statement(
        `UPDATE ${qualified} SET "publishedAt" = now() WHERE "id" = ANY(string_to_array(`,
        ", ',')::bigint[])",
      ),
      ids.join(","),
    )
      .affectedCount()
      .build();

  const read = async (tx: Queryable, tenantId: string, limit: number) =>
    ((await tx.query(select(tenantId, limit))) as readonly Row[]).map((row): OutboxMessage => ({
      ...row,
      id: safe(row.id),
      occurredAt: new Date(row.occurredAt),
    }));

  const transaction = <R>(work: (tx: Queryable) => Promise<R>) =>
    fromSafePromise(
      Promise.resolve().then(() => db.transaction((tx) => work(tx as unknown as Queryable))),
    );

  return {
    pending: (tenantId, limit) => transaction((tx) => read(tx, tenantId, limit)),
    oldestPending: (tenantIds) =>
      transaction(async (tx) =>
        (
          (await tx.query(oldest(tenantIds))) as readonly {
            readonly tenantId: string;
            readonly occurredAt: string;
          }[]
        ).map(({ tenantId, occurredAt }) => ({ tenantId, occurredAt: new Date(occurredAt) })),
      ),
    claim: (tenantId, limit, relay) =>
      transaction(async (tx) => {
        const [held] = (await tx.query(lock(tenantId))) as readonly { readonly locked: string }[];
        if (held?.locked !== "true") return;
        const published = await relay(await read(tx, tenantId, limit)).get();
        if (published.length > 0) await tx.query(mark(published));
      }),
  };
};
