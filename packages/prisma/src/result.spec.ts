import { describe, expect, it } from "vitest";

import { tryQuery } from "./result.js";

/** What a Prisma 8 `SqlQueryError` carries, as the qualifier reads it. */
const sqlError = (sqlState: string, extra?: Record<string, string>) =>
  Object.assign(new Error(`refused: ${sqlState}`), { sqlState, ...extra });

describe("tryQuery", () => {
  it("answers the query's value on the Ok channel", async () => {
    // GIVEN a query that resolves
    // WHEN it is run
    const answered = await tryQuery(() => Promise.resolve([{ id: 1 }]));

    // THEN the value crosses unchanged — the combinator is transparent
    expect(answered).toBeOkWith([{ id: 1 }]);
  });

  it("names a unique violation with the constraint the database named", async () => {
    // GIVEN a write the unique index refused — SQLSTATE 23505
    // WHEN it is run
    const refused = await tryQuery(() =>
      Promise.reject(
        sqlError("23505", { constraint: "order_tenantId_orderId_key", table: "order" }),
      ),
    );

    // THEN the constraint rides the error: `P2002` could not say which index
    // fired, which is what made a table with two of them ambiguous
    expect(refused).toBeErrWith(
      expect.objectContaining({
        _tag: "UniqueConstraintViolation",
        constraint: "order_tenantId_orderId_key",
        table: "order",
      }),
    );
  });

  it("names a foreign-key violation", async () => {
    // GIVEN a write a relation refused — SQLSTATE 23503
    // WHEN it is run
    const refused = await tryQuery(() =>
      Promise.reject(sqlError("23503", { constraint: "order_customerId_fkey" })),
    );

    // THEN it is the modeled arm rather than a defect
    expect(refused).toBeErrWith(
      expect.objectContaining({
        _tag: "ForeignKeyViolation",
        constraint: "order_customerId_fkey",
      }),
    );
  });

  it("names a refusal the row-security policy made", async () => {
    // GIVEN a write outside the policy's `WITH CHECK` — SQLSTATE 42501
    // WHEN it is run
    const refused = await tryQuery(() => Promise.reject(sqlError("42501", { table: "order" })));

    // THEN it is modeled, because only the caller knows whether reaching it is
    // a bug (an adapter bound to one tenant) or a request
    expect(refused).toBeErrWith(expect.objectContaining({ _tag: "NotAuthorized", table: "order" }));
  });

  it("defects on a SQLSTATE nothing models", async () => {
    // GIVEN a deadlock — infrastructure a caller cannot act on differently
    // WHEN it is run
    const failed = await tryQuery(() => Promise.reject(sqlError("40P01")));

    // THEN it is a defect, not a fourth arm nobody would branch on
    expect(failed).toBeDefectWith(expect.objectContaining({ sqlState: "40P01" }));
  });

  it("defects on a rejection that is not a SQL error at all", async () => {
    // GIVEN a socket that died, which carries no `sqlState`
    // WHEN it is run
    const failed = await tryQuery(() => Promise.reject(new Error("ECONNRESET")));

    // THEN the same channel: the qualifier reads a field that is not there and
    // hands the cause to `defect` rather than guessing
    expect(failed).toBeDefectWith(expect.objectContaining({ message: "ECONNRESET" }));
  });

  it("catches a thunk that throws synchronously", async () => {
    // GIVEN work that fails before it ever returns a promise — a builder
    // rejecting its arguments, say
    // WHEN it is run
    const failed = await tryQuery(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the synchronous throw IS the subject: it is the channel this function exists to close
      throw sqlError("23505", { constraint: "c" });
    });

    // THEN it lands on the Result's channel rather than escaping as a real
    // throw, which is what `Promise.resolve().then(run)` buys over `run()`
    expect(failed).toBeErrWith(expect.objectContaining({ _tag: "UniqueConstraintViolation" }));
  });
});
