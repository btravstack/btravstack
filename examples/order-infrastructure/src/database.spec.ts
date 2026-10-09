import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

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
});
