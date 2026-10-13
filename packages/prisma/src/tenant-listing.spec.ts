import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { tenantListing } from "./rls.js";

describe("tenantListing", () => {
  it("reads tenant IDs through only the declared function", async ({ stub }) => {
    // GIVEN a declared listing and a client answering tenant IDs
    const listing = tenantListing({
      schema: "orders",
      table: "Order",
      name: "order_tenants",
      owner: "migrator",
      role: "app",
    }).getOrThrow();
    const db = stub.client({ url: "postgres://localhost/orders", middleware: [] });
    db.answerRows([{ tenantId: "acme" }, { tenantId: "other" }]);

    // WHEN its typed query runs
    const result = await listing.list(db);

    // THEN it calls the zero-argument capability and returns only IDs
    expect({ result: result.getOrThrow(), queries: db.ran() }).toEqual({
      result: ["acme", "other"],
      queries: [
        {
          sql: 'SELECT "tenantId" FROM "orders"."order_tenants"()',
          values: [],
          kind: "row",
          tx: undefined,
        },
      ],
    });
  });

  it("qualifies a denied function call", async ({ stub, sqlError }) => {
    // GIVEN a caller with no execution grant
    const listing = tenantListing({
      schema: "orders",
      table: "Order",
      name: "order_tenants",
      owner: "migrator",
      role: "app",
    }).getOrThrow();
    const db = stub.client({ url: "postgres://localhost/orders", middleware: [] });
    db.breakQueriesWith(sqlError("42501"));

    // WHEN it calls the listing
    const result = await listing.list(db);

    // THEN the denial is modeled
    expect(result).toBeErrTagged("NotAuthorized");
  });

  it.for(["", "x\0y", "x".repeat(64), "é".repeat(32), "\ud800"])(
    "refuses invalid identifiers %s",
    (schema) => {
      // GIVEN a schema name PostgreSQL cannot preserve
      // WHEN the listing is declared
      const result = tenantListing({
        schema,
        table: "Order",
        name: "order_tenants",
        owner: "migrator",
        role: "app",
      });

      // THEN no migration or query can be produced
      expect(result).toBeErrWith(
        expect.objectContaining({ field: "schema", reason: "invalid-identifier" }),
      );
    },
  );

  it("refuses a caller that is also the privileged owner", () => {
    // GIVEN identical owner and caller roles
    // WHEN a listing is declared
    const result = tenantListing({
      schema: "orders",
      table: "Order",
      name: "order_tenants",
      owner: "app",
      role: "app",
    });

    // THEN it cannot give that caller an owner-only policy
    expect(result).toBeErrWith(expect.objectContaining({ field: "role", reason: "shared-role" }));
  });

  it("quotes physical names rather than interpreting them as SQL", async ({ stub }) => {
    // GIVEN identifiers containing SQL punctuation
    const listing = tenantListing({
      schema: 'odd"schema',
      table: "data",
      name: 'list"; SELECT 1; --',
      owner: "migrator",
      role: "app",
      tenantColumn: "organization",
    }).getOrThrow();
    const db = stub.client({ url: "postgres://localhost/orders", middleware: [] });

    // WHEN the query is constructed and executed
    await listing.list(db);

    // THEN every name remains one quoted identifier
    expect(db.ran()).toEqual([
      {
        sql: 'SELECT "tenantId" FROM "odd""schema"."list""; SELECT 1; --"()',
        values: [],
        kind: "row",
        tx: undefined,
      },
    ]);
  });
});
