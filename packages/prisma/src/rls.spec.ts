import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { tenantPinned, type TenantPinnedOptions } from "./rls.js";

const binding = { url: "postgres://localhost:5432/orders", middleware: [] };

describe("tenantPinned", () => {
  it.for([
    [{ isolationLevel: "read committed" }, "ISOLATION LEVEL READ COMMITTED"],
    [{ isolationLevel: "repeatable read" }, "ISOLATION LEVEL REPEATABLE READ"],
    [{ isolationLevel: "serializable" }, "ISOLATION LEVEL SERIALIZABLE"],
    [{ readOnly: true }, "READ ONLY"],
    [{ readOnly: false }, "READ WRITE"],
    [
      { isolationLevel: "repeatable read", readOnly: true },
      "ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    ],
  ] as const)("establishes %j before the tenant pin", async ([options, mode], { stub }) => {
    // Arrange
    const db = stub.client(binding);

    // Act
    await tenantPinned(
      db,
      "acme",
      (tx) => tx.query(db.raw.sql`SELECT 1`.affectedCount().build()),
      options,
    );

    // Assert
    expect(db.ran()).toEqual([
      { sql: `SET TRANSACTION ${mode}`, values: [], kind: "affectedCount", tx: 1 },
      {
        sql: "SELECT set_config(?, ?, ?) AS pinned",
        values: ["app.tenant_id", "acme", true],
        kind: "row",
        tx: 1,
      },
      { sql: "SELECT 1", values: [], kind: "affectedCount", tx: 1 },
    ]);
  });

  it.for([
    { isolationLevel: "read uncommitted" },
    { isolationLevel: "REPEATABLE READ" },
    { isolationLevel: "serializable; SELECT 1" },
    { readOnly: "true" },
    { readOnly: null },
  ])("refuses unsupported characteristics %j before running work", async (options, { stub }) => {
    // Arrange
    const db = stub.client(binding);
    let worked = false;

    // Act
    const result = await tenantPinned(
      db,
      "acme",
      async () => {
        worked = true;
      },
      options as TenantPinnedOptions,
    );

    // Assert
    expect({ result, worked, ran: db.ran() }).toEqual({
      result: expect.objectContaining({ tag: "Defect", cause: expect.any(TypeError) }),
      worked: false,
      ran: [],
    });
  });

  it("does not pin or run work after characteristics fail", async ({ stub }) => {
    // Arrange
    const db = stub.client(binding);
    const cause = new Error("SET TRANSACTION refused");
    db.breakQueriesWith(cause);
    let worked = false;

    // Act
    const result = await tenantPinned(
      db,
      "acme",
      async () => {
        worked = true;
      },
      { readOnly: true },
    );

    // Assert
    expect({ result, worked, ran: db.ran() }).toEqual({
      result: expect.objectContaining({ tag: "Defect", cause }),
      worked: false,
      ran: [{ sql: "SET TRANSACTION READ ONLY", values: [], kind: "affectedCount", tx: 1 }],
    });
  });

  it("pins the tenant on the transaction's own connection, before the work", async ({ stub }) => {
    // GIVEN a client and a unit of work that issues one statement of its own
    const db = stub.client(binding);

    // WHEN the work runs pinned
    await tenantPinned(db, "acme", (tx) => tx.query(db.raw.sql`SELECT 1`.affectedCount().build()));

    // THEN the pin ran FIRST and in the SAME transaction as the work — a pin on
    // another connection pins nothing, and the policy then denies every row
    expect(db.ran()).toEqual([
      {
        sql: "SELECT set_config(?, ?, ?) AS pinned",
        values: ["app.tenant_id", "acme", true],
        kind: "row",
        tx: 1,
      },
      { sql: "SELECT 1", values: [], kind: "affectedCount", tx: 1 },
    ]);
  });

  it("reads the setting the policy names, when the policy names another", async ({ stub }) => {
    // GIVEN a deployment whose policy reads its own run-time setting
    const db = stub.client(binding);

    // WHEN the work runs pinned under that name
    await tenantPinned(db, "acme", () => Promise.resolve(undefined), { setting: "app.org_id" });

    // THEN that is the name the pin set: a policy reading a different one denies
    // every row, which looks exactly like row security working
    expect(db.ran()).toEqual([expect.objectContaining({ values: ["app.org_id", "acme", true] })]);
  });

  it("hands the work's own answer back", async ({ stub }) => {
    // GIVEN a client
    const db = stub.client(binding);

    // WHEN the work answers something
    const answered = await tenantPinned(db, "acme", () => Promise.resolve(["a", "b"]));

    // THEN the pin is transparent to it, on the Ok channel
    expect(answered).toBeOkWith(["a", "b"]);
  });

  it("pins LOCAL, so the setting dies with the transaction", async ({ stub }) => {
    // GIVEN a client
    const db = stub.client(binding);

    // WHEN the work runs pinned
    await tenantPinned(db, "acme", () => Promise.resolve(undefined));

    // THEN `set_config`'s third argument is `true`, and the statement ran
    // inside the transaction: a session-scoped pin would outlive it and reach
    // whatever the pool hands the connection to next, which is a tenant leak
    // rather than a stale setting
    expect(db.ran()).toEqual([
      {
        sql: "SELECT set_config(?, ?, ?) AS pinned",
        values: ["app.tenant_id", "acme", true],
        kind: "row",
        tx: 1,
      },
    ]);
  });
});
