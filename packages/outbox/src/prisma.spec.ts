import { OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { it, type StubRow } from "./__tests__/test-fixtures.js";
import { prismaOutboxStore } from "./prisma.js";

const row: StubRow = {
  id: 7,
  tenantId: "acme",
  kind: "order",
  subjectId: "a",
  payload: null,
  occurredAt: "2026-10-06T21:00:00.123456+00:00",
};

const LOCK = "SELECT pg_try_advisory_xact_lock(hashtext(?), hashtext(?))::text AS locked";
const SELECT = (table: string) =>
  `SELECT "id", "tenantId", "kind", "subjectId", "payload", to_json("occurredAt") #>> '{}' AS "occurredAt" FROM ${table} WHERE "tenantId" = ? AND "publishedAt" IS NULL ORDER BY "id" LIMIT ?::int`;

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
      { sql: LOCK, values: ["orders.outboxMessage", "acme"], tx: 1 },
      { sql: SELECT(`"orders"."outboxMessage"`), values: ["acme", "32"], tx: 1 },
      {
        sql: `UPDATE "orders"."outboxMessage" SET "publishedAt" = now() WHERE "id" = ANY(string_to_array(?, ',')::int[])`,
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
      { ...row, occurredAt: new Date("2026-10-06T21:00:00.123456+00:00") },
    ]);
  });

  it("reads every tenant's oldest pending time in one statement", async ({ stub }) => {
    // GIVEN a client answering one tenant's oldest pending row
    const db = stub({ rows: [row] });

    // WHEN the oldest pending time of three tenants is asked for
    const asked = await prismaOutboxStore(db)
      .oldestPending(["acme", 'gl"obex', "initech"])
      .map((oldest) => ({ oldest, ran: db.ran() }));

    // THEN one statement carried all three as a JSON array, and the time came
    // back a Date
    expect(asked).toBeOkWith({
      oldest: [{ tenantId: "acme", occurredAt: new Date(row.occurredAt) }],
      ran: [
        {
          sql: `SELECT "tenantId", to_json(min("occurredAt")) #>> '{}' AS "occurredAt" FROM "public"."outboxMessage" WHERE "publishedAt" IS NULL AND "tenantId" IN (SELECT json_array_elements_text(?::json)) GROUP BY "tenantId"`,
          values: ['["acme","gl\\"obex","initech"]'],
          tx: 1,
        },
      ],
    });
  });

  it("quotes the identifiers it is given", async ({ stub }) => {
    // GIVEN a schema name carrying a quote
    const db = stub({});

    // WHEN the store reads
    await prismaOutboxStore(db, { schema: 'we"ird' }).pending("acme", 1);

    // THEN the quote was doubled inside a quoted identifier
    expect(db.ran().map(({ sql }) => sql)).toEqual([SELECT(`"we""ird"."outboxMessage"`)]);
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
