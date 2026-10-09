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

/** The table's physical column names, where they are not the documented model's field names. */
export type OutboxColumns = {
  readonly id?: string;
  readonly tenantId?: string;
  readonly kind?: string;
  readonly subjectId?: string;
  readonly payload?: string;
  readonly occurredAt?: string;
  readonly publishedAt?: string;
};

/** Where the table lives, and what its tenant boundary is called. */
export type PrismaOutboxStoreOptions = {
  /** The namespace the model is declared in (default `public`). */
  readonly schema?: string;
  /** The table Prisma maps the model to (default `outboxMessage`, the table of a model named `OutboxMessage`). */
  readonly table?: string;
  /** Each column's physical name, for a table mapped with `@map` (default: the field names). */
  readonly columns?: OutboxColumns;
  /**
   * The run-time setting each tenant's reads and marks are pinned to, which a
   * row-level-security policy on the table reads (default `app.tenant_id`, as
   * `@btravstack/prisma/rls`'s `tenantPinned`).
   */
  readonly tenantSetting?: string;
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
  const setting = options.tenantSetting ?? "app.tenant_id";
  const qualified = `${identifier(schema)}.${identifier(table)}`;
  const column = (field: keyof OutboxColumns): string =>
    identifier(options.columns?.[field] ?? field);
  const { sql } = (db as unknown as Raw).raw;

  // `idle_in_transaction_session_timeout` is lifted for this transaction alone:
  // the claim sits idle while the publisher works, and a server that ended the
  // session there would free the lock mid-batch for another relay to take. The
  // tenant is pinned in the same statement, transaction-locally, so a policy
  // admits this tenant's rows to the read and the mark that follow, and no pin
  // outlives the transaction on a pooled connection.
  const lock = (tenantId: string) =>
    sql`SELECT set_config('idle_in_transaction_session_timeout', '0', true) AS lifted, set_config(${setting}, ${tenantId}, true) AS pinned, pg_try_advisory_xact_lock(hashtext(${`${schema}.${table}`}), hashtext(${tenantId}))::text AS locked`
      .returnsRow({ lifted: "pg/text@1", pinned: "pg/text@1", locked: "pg/text@1" })
      .build();

  const pin = (tenantId: string) =>
    sql`SELECT set_config(${setting}, ${tenantId}, true) AS pinned`
      .returnsRow({ pinned: "pg/text@1" })
      .build();

  const pending = `${column("publishedAt")} IS NULL`;

  const select = (tenantId: string, limit: number) =>
    sql(
      statement(
        `SELECT ${column("id")} AS "id", ${column("tenantId")} AS "tenantId", ${column("kind")} AS "kind", ${column("subjectId")} AS "subjectId", ${column("payload")} AS "payload", to_json(${column("occurredAt")}) #>> '{}' AS "occurredAt" FROM ${qualified} WHERE ${column("tenantId")} = `,
        ` AND ${pending} ORDER BY ${column("id")} LIMIT `,
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

  const oldest = (tenantId: string) =>
    sql(
      statement(
        `SELECT to_json(min(${column("occurredAt")})) #>> '{}' AS "occurredAt" FROM ${qualified} WHERE ${column("tenantId")} = `,
        ` AND ${pending}`,
      ),
      tenantId,
    )
      .returnsRow({ occurredAt: "pg/text@1" })
      .build();

  const mark = (ids: readonly number[]) =>
    sql(
      statement(
        `UPDATE ${qualified} SET ${column("publishedAt")} = now() WHERE ${column("id")} = ANY(string_to_array(`,
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
    pending: (tenantId, limit) =>
      transaction(async (tx) => {
        await tx.query(pin(tenantId));
        return read(tx, tenantId, limit);
      }),
    // One transaction, one connection, a pinned read per tenant: a policy is
    // read once per statement, so no single statement can see two tenants.
    oldestPending: (tenantIds) =>
      transaction(async (tx) => {
        const oldestOf: { readonly tenantId: string; readonly occurredAt: Date }[] = [];
        for (const tenantId of tenantIds) {
          await tx.query(pin(tenantId));
          const [row] = (await tx.query(oldest(tenantId))) as readonly {
            readonly occurredAt: string | null;
          }[];
          if (row?.occurredAt != null)
            oldestOf.push({ tenantId, occurredAt: new Date(row.occurredAt) });
        }
        return oldestOf;
      }),
    claim: (tenantId, limit, relay) =>
      transaction(async (tx) => {
        const [held] = (await tx.query(lock(tenantId))) as readonly { readonly locked: string }[];
        if (held?.locked !== "true") return;
        const published = await relay(await read(tx, tenantId, limit)).get();
        if (published.length > 0) await tx.query(mark(published));
      }),
  };
};
