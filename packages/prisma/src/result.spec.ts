import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { tryQuery } from "./result.js";

describe("tryQuery", () => {
  it("answers the query's value on the Ok channel", async () => {
    // GIVEN a query that resolves
    // WHEN it is run
    const answered = await tryQuery(() => Promise.resolve([{ id: 1 }]));

    // THEN the value crosses unchanged — the combinator is transparent
    expect(answered).toBeOkWith([{ id: 1 }]);
  });

  it("names a unique violation with the constraint the database named", async ({ sqlError }) => {
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

  it("names a foreign-key violation", async ({ sqlError }) => {
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

  it("names a refusal the row-security policy made", async ({ sqlError }) => {
    // GIVEN a write outside the policy's `WITH CHECK` — SQLSTATE 42501
    // WHEN it is run
    const refused = await tryQuery(() => Promise.reject(sqlError("42501", { table: "order" })));

    // THEN it is modeled, because only the caller knows whether reaching it is
    // a bug (an adapter bound to one tenant) or a request
    expect(refused).toBeErrWith(expect.objectContaining({ _tag: "NotAuthorized", table: "order" }));
  });

  it("defects on a SQLSTATE nothing models", async ({ sqlError }) => {
    // GIVEN a deadlock — infrastructure a caller cannot act on differently
    // WHEN it is run
    const failed = await tryQuery(() => Promise.reject(sqlError("40P01")));

    // THEN it is a defect, not a fourth arm nobody would branch on
    expect(failed).toBeDefectWith(expect.objectContaining({ sqlState: "40P01" }));
  });

  it("names a SQLSTATE the application raises, once it is listed", async ({ sqlError }) => {
    // GIVEN a trigger's guard refusing a write in a class of the application's own
    // WHEN it is run with that code listed
    const refused = await tryQuery(() => Promise.reject(sqlError("OR001", { table: "order" })), {
      raises: ["OR001"],
    });

    // THEN it is modeled, carrying the code, the message the RAISE wrote and the table
    expect(refused).toBeErrWith(
      expect.objectContaining({
        _tag: "RaisedException",
        sqlState: "OR001",
        message: "refused: OR001",
        table: "order",
        constraint: undefined,
      }),
    );
  });

  it("defects on a raised SQLSTATE that is not listed", async ({ sqlError }) => {
    // GIVEN a guard raising a code the caller did not list
    // WHEN it is run listing another
    const failed = await tryQuery(() => Promise.reject(sqlError("OR002")), {
      raises: ["OR001"],
    });

    // THEN listing is per code: an unlisted one is still a defect
    expect(failed).toBeDefectWith(expect.objectContaining({ sqlState: "OR002" }));
  });

  it("keeps a modeled SQLSTATE on its own arm when it is listed too", async ({ sqlError }) => {
    // GIVEN a unique violation, whose code the caller also listed
    // WHEN it is run
    const refused = await tryQuery(() => Promise.reject(sqlError("23505")), {
      raises: ["23505"],
    });

    // THEN the dedicated arm wins: `raises` adds arms, it never moves one
    expect(refused).toBeErrTagged("UniqueConstraintViolation");
  });

  it("defects on a rejection that is not a SQL error at all", async () => {
    // GIVEN a socket that died, which carries no `sqlState`
    // WHEN it is run
    const failed = await tryQuery(() => Promise.reject(new Error("ECONNRESET")));

    // THEN the same channel: the qualifier reads a field that is not there and
    // hands the cause to `defect` rather than guessing
    expect(failed).toBeDefectWith(expect.objectContaining({ message: "ECONNRESET" }));
  });

  it("defects on a rejection carrying nothing at all", async () => {
    // GIVEN a driver rejecting with `undefined`, which nothing obliges it not to do
    // WHEN it is run with a code listed
    const failed = await tryQuery(() => Promise.reject(undefined), { raises: ["OR001"] });

    // THEN there is no SQLSTATE to read, so it is a defect rather than a crash in the qualifier
    expect(failed).toBeDefectWith(undefined);
  });

  it("catches a thunk that throws synchronously", async ({ sqlError }) => {
    // GIVEN work that fails before it ever returns a promise — a client
    // validating its URL at construction, say
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
