import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it, type StubRow } from "./__tests__/test-fixtures.js";
import { prismaOutboxStore } from "./prisma.js";

const row: StubRow = {
  id: 7n,
  tenantId: "acme",
  kind: "order",
  subjectId: "a",
  payload: null,
  occurredAt: "2026-10-06T21:00:00.123456+00:00",
};

const LOCK =
  "SELECT set_config('idle_in_transaction_session_timeout', '0', true) AS lifted, set_config(?, ?, true) AS pinned, pg_try_advisory_xact_lock(hashtext(?), hashtext(?))::text AS locked";
const PIN = "SELECT set_config(?, ?, true) AS pinned";
const SELECT = (table: string) =>
  `SELECT "id" AS "id", "tenantId" AS "tenantId", "kind" AS "kind", "subjectId" AS "subjectId", "payload" AS "payload", to_json("occurredAt") #>> '{}' AS "occurredAt" FROM ${table} WHERE "tenantId" = ? AND "publishedAt" IS NULL ORDER BY "id" LIMIT ?::int`;
const OLDEST = `SELECT to_json(min("occurredAt")) #>> '{}' AS "occurredAt" FROM "public"."outboxMessage" WHERE "tenantId" = ? AND "publishedAt" IS NULL`;

describe("prismaOutboxStore", () => {
  it("locks the tenant, reads, and marks what was published — in one transaction", async ({
    stub,
  }) => {
    // GIVEN a client whose lock is free and whose tenant has one pending row
    const db = stub({ rows: [row] });

    // WHEN a claim publishes it
    await prismaOutboxStore(db, { schema: "orders" }).claim("acme", 32, (batch) =>
      OkAsync(batch.map(({ id }) => id)),
    );

    // THEN the lock came first and all three statements shared its transaction,
    // so the lock is held exactly as long as the mark is uncommitted
    expect(db.ran()).toEqual([
      { sql: LOCK, values: ["app.tenant_id", "acme", "orders.outboxMessage", "acme"], tx: 1 },
      { sql: SELECT(`"orders"."outboxMessage"`), values: ["acme", "32"], tx: 1 },
      {
        sql: `UPDATE "orders"."outboxMessage" SET "publishedAt" = now() WHERE "id" = ANY(string_to_array(?, ',')::bigint[])`,
        values: ["7"],
        tx: 1,
      },
    ]);
  });

  it("skips a tenant whose lock another relay holds", async ({ stub }) => {
    // GIVEN a client whose lock is taken
    const db = stub({ locked: false, rows: [row] });
    let handed = false;

    // WHEN a claim is attempted
    await prismaOutboxStore(db).claim("acme", 32, (batch) => {
      handed = true;
      return OkAsync(batch.map(({ id }) => id));
    });

    // THEN nothing was read and the relay was never called
    expect({ handed, ran: db.ran().map(({ sql }) => sql) }).toEqual({
      handed: false,
      ran: [LOCK],
    });
  });

  it("writes no mark when nothing was published", async ({ stub }) => {
    // GIVEN a pending row the relay could not publish
    const db = stub({ rows: [row] });

    // WHEN the claim's relay publishes nothing
    await prismaOutboxStore(db).claim("acme", 32, () => OkAsync([]));

    // THEN the transaction read and stopped
    expect(db.ran().map(({ sql }) => sql)).toEqual([LOCK, SELECT(`"public"."outboxMessage"`)]);
  });

  it("reads pending rows with their time as a Date", async ({ stub }) => {
    // GIVEN a pending row
    const db = stub({ rows: [row] });

    // WHEN they are read
    const pending = await prismaOutboxStore(db, { table: "events" }).pending("acme", 1);

    // THEN the ISO text became a Date
    expect(pending).toBeOkWith([
      { ...row, id: 7, occurredAt: new Date("2026-10-06T21:00:00.123456+00:00") },
    ]);
  });

  it("refuses an id past 2^53 rather than rounding it onto another row's", async ({ stub }) => {
    // GIVEN a row whose int8 id no JS number names exactly
    const db = stub({ rows: [{ ...row, id: 2n ** 53n + 1n }] });

    // WHEN it is read
    const pending = await prismaOutboxStore(db).pending("acme", 1);

    // THEN it is the defect an impossible row is, not a rounded id that would
    // mark — and deduplicate on — a neighbour
    expect(pending).toBeDefectWith(
      expect.objectContaining({
        constructor: RangeError,
        message: expect.stringContaining("2^53"),
      }),
    );
  });

  it("reads each tenant's oldest pending time pinned to that tenant, in one transaction", async ({
    stub,
  }) => {
    // GIVEN a client where one of three tenants has something pending
    const db = stub({ oldest: { acme: row.occurredAt } });

    // WHEN the oldest pending time of the three is asked for
    const asked = await prismaOutboxStore(db)
      .oldestPending(["acme", "globex", "initech"])
      .map((oldest) => ({ oldest, ran: db.ran() }));

    // THEN each read was pinned to its own tenant, all on one connection, and a
    // tenant with nothing pending is absent rather than undated
    expect(asked).toBeOkWith({
      oldest: [{ tenantId: "acme", occurredAt: new Date(row.occurredAt) }],
      ran: ["acme", "globex", "initech"].flatMap((tenant) => [
        { sql: PIN, values: ["app.tenant_id", tenant], tx: 1 },
        { sql: OLDEST, values: [tenant], tx: 1 },
      ]),
    });
  });

  it("names the columns a mapped table declares", async ({ stub }) => {
    // GIVEN a table whose columns are snake_case
    const db = stub({ rows: [row] });

    // WHEN a claim publishes its batch
    await prismaOutboxStore(db, {
      columns: {
        tenantId: "tenant_id",
        subjectId: "subject_id",
        occurredAt: "occurred_at",
        publishedAt: "published_at",
      },
    }).claim("acme", 32, (batch) => OkAsync(batch.map(({ id }) => id)));

    // THEN every statement names the physical column and reads it back under
    // the port's own name
    expect(db.ran().map(({ sql }) => sql)).toEqual([
      LOCK,
      `SELECT "id" AS "id", "tenant_id" AS "tenantId", "kind" AS "kind", "subject_id" AS "subjectId", "payload" AS "payload", to_json("occurred_at") #>> '{}' AS "occurredAt" FROM "public"."outboxMessage" WHERE "tenant_id" = ? AND "published_at" IS NULL ORDER BY "id" LIMIT ?::int`,
      `UPDATE "public"."outboxMessage" SET "published_at" = now() WHERE "id" = ANY(string_to_array(?, ',')::bigint[])`,
    ]);
  });

  it("pins the setting the table's policy reads", async ({ stub }) => {
    // GIVEN a policy reading a setting of the application's own naming
    const db = stub({});

    // WHEN a tenant's rows are read
    await prismaOutboxStore(db, { tenantSetting: "orders.tenant" }).pending("acme", 1);

    // THEN that setting is the one pinned
    expect(db.ran()[0]).toEqual({ sql: PIN, values: ["orders.tenant", "acme"], tx: 1 });
  });

  it("quotes the identifiers it is given", async ({ stub }) => {
    // GIVEN a schema name carrying a quote
    const db = stub({});

    // WHEN the store reads
    await prismaOutboxStore(db, { schema: 'we"ird' }).pending("acme", 1);

    // THEN the quote was doubled inside a quoted identifier
    expect(db.ran().map(({ sql }) => sql)).toEqual([PIN, SELECT(`"we""ird"."outboxMessage"`)]);
  });

  it("answers a database that will not answer as a defect", async ({ stub }) => {
    // GIVEN a client whose every transaction fails
    const db = stub({ failure: new Error("connection refused") });

    // WHEN a claim is attempted
    const claimed = await prismaOutboxStore(db).claim("acme", 32, () => OkAsync([]));

    // THEN it is the defect the port's `never` promises, not a modeled error
    expect(claimed).toBeDefectWith(expect.objectContaining({ message: "connection refused" }));
  });
});
