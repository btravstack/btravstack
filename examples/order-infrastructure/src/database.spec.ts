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
