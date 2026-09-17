import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { tenantPinned } from "./rls.js";

const binding = { url: "postgres://localhost:5432/orders", middleware: [] };

describe("tenantPinned", () => {
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

    // THEN the pin is transparent to it
    expect(answered).toEqual(["a", "b"]);
  });

  it("pins LOCAL, so the setting dies with the transaction", async ({ stub }) => {
    // GIVEN a client
    const db = stub.client(binding);

    // WHEN the work runs pinned
    await tenantPinned(db, "acme", () => Promise.resolve(undefined));

    // THEN `set_config`'s third argument is `true`: a session-scoped pin would
    // outlive the transaction and reach whatever the pool hands the connection
    // to next, which is a tenant leak rather than a stale setting
    expect(db.ran()[0]?.values[2]).toBe(true);
  });
});
