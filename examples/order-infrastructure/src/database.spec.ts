import { tryQuery } from "@btravstack/prisma/result";
import { tenantPinned } from "@btravstack/prisma/rls";
import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, inject } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("the database a scope opens", () => {
  it("serves a burst of transactions larger than its pool, from its first statement", async ({
    freshScope,
  }) => {
    // GIVEN a freshly opened scope, and more concurrent transactions than its pool of ten
    const burst = 25;

    // WHEN every transaction runs its first statement at once
    const committed = await freshScope((db) =>
      fromSafePromise(
        Promise.allSettled(
          Array.from({ length: burst }, () =>
            db.transaction((tx) => tx.query(db.raw.sql`SELECT 1`.affectedCount().build())),
          ),
        ).then((settled) => settled.filter(({ status }) => status === "fulfilled").length),
      ),
    );

    // THEN all of them committed: the contract marker was verified before any of them took a connection
    expect(committed).toBeOkWith(burst);
  });

  it("refuses to open as the role that ran the migrations", async ({ freshScope }) => {
    // GIVEN the URL of the bootstrap superuser, which owns every table it migrated
    const owner = inject("__ORDERS_OWNER_DATABASE_URL__");

    // WHEN a scope is opened as that role
    const opened = await freshScope(() => OkAsync(undefined), owner);

    // THEN the boot is refused: every policy would admit every row for it
    expect(opened).toBeErrWith(
      expect.objectContaining({
        _tag: "RowSecurityBypassed",
        database: "FreshDatabase",
        role: "btravstack",
        bypass: "superuser",
        tables: expect.arrayContaining(['orders."order"', 'orders."outboxMessage"']),
      }),
    );
  });

  it("opens as the application role, which row security applies to", async ({ freshScope }) => {
    // GIVEN the application role's URL, a role that neither owns nor bypasses anything
    // WHEN a scope is opened as that role
    const opened = await freshScope(() => OkAsync("opened"));

    // THEN it opens
    expect(opened).toBeOkWith("opened");
  });
});

describe("an exception the database raises on purpose", () => {
  it("arrives modeled when its SQLSTATE is listed", async ({ db }) => {
    // GIVEN a guard refusing in a class of the application's own, as a trigger would
    // WHEN it runs with that code listed
    const refused = await tryQuery(
      () =>
        db
          .runtime()
          .query(
            db.raw
              .sql`DO $$ BEGIN RAISE EXCEPTION 'quantity is frozen' USING ERRCODE = 'OR001'; END $$`
              .affectedCount()
              .build(),
          ),
      { raises: ["OR001"] },
    );

    // THEN it is the modeled arm, carrying the code and the message the RAISE wrote
    expect(refused).toBeErrWith(
      expect.objectContaining({
        _tag: "RaisedException",
        sqlState: "OR001",
        message: expect.stringContaining("quantity is frozen"),
      }),
    );
  });

  it("arrives modeled from inside a pinned transaction too", async ({ db, tenant }) => {
    // GIVEN the same guard, reached from a tenant's pinned unit of work
    // WHEN it runs with that code listed
    const refused = await tenantPinned(
      db,
      tenant,
      (tx) =>
        tx.query(
          db.raw
            .sql`DO $$ BEGIN RAISE EXCEPTION 'quantity is frozen' USING ERRCODE = 'OR001'; END $$`
            .affectedCount()
            .build(),
        ),
      { raises: ["OR001"] },
    );

    // THEN the transaction's rejection is qualified the same way
    expect(refused).toBeErrTagged("RaisedException");
  });

  it("is a defect when its SQLSTATE is not listed", async ({ db }) => {
    // GIVEN the same guard
    // WHEN it runs with nothing listed
    const failed = await tryQuery(() =>
      db
        .runtime()
        .query(
          db.raw
            .sql`DO $$ BEGIN RAISE EXCEPTION 'quantity is frozen' USING ERRCODE = 'OR001'; END $$`
            .affectedCount()
            .build(),
        ),
    );

    // THEN it stays on the defect channel, as every unmodeled SQLSTATE does
    expect(failed).toBeDefectWith(expect.objectContaining({ sqlState: "OR001" }));
  });
});
