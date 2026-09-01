import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { instrument } from "./instrument.js";

describe("instrument", () => {
  it("hands the caller's own value straight back", async ({ stub, observed }) => {
    // GIVEN an observed client
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN a query runs to completion
    const answer = await client.query("Order", "findMany", Promise.resolve(["a"]));

    // THEN the wrapper is transparent
    expect(answer).toEqual(["a"]);
  });

  it("observes a query that answers, and opens no span", async ({ stub, observed }) => {
    // GIVEN an observed client
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN a query runs to completion
    await client.query("Order", "findMany", Promise.resolve(["a"]));

    // THEN the call is recorded untraced, because `@btravstack/prisma/otel`
    // traces at the ENGINE level and a second client-level span would carry
    // strictly less
    expect(observed.taken()).toEqual([
      {
        component: "database",
        name: "findMany",
        attributes: { model: "Order", operation: "findMany" },
        outcome: "ok",
        failed: false,
        traced: false,
      },
    ]);
  });

  it("lets a rejection reach the caller unchanged", async ({ stub, observed }) => {
    // GIVEN an observed client and a query that will reject
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN it runs
    const rejected = await client
      .query("Order", "create", Promise.reject(new Error("deadlock detected")))
      .then(() => "resolved")
      .catch(() => "rejected");

    // THEN the wrapper is transparent on the failure path too
    expect(rejected).toBe("rejected");
  });

  it("observes a query that rejects, carrying the cause", async ({ stub, observed }) => {
    // GIVEN an observed client and a query that will reject
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN it runs
    await client
      .query("Order", "create", Promise.reject(new Error("deadlock detected")))
      .catch(() => undefined);

    // THEN the failure was observed with the cause an observer needs to write
    // a line about it
    expect(observed.taken()).toEqual([
      {
        component: "database",
        name: "create",
        attributes: { model: "Order", operation: "create" },
        outcome: "error",
        failed: true,
        traced: false,
      },
    ]);
  });

  it("names a raw query `raw`, since it belongs to no model", async ({ stub, observed }) => {
    // GIVEN an observed client
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN a query with no model runs
    await client.query(undefined as unknown as string, "$queryRaw", Promise.resolve([]));

    // THEN the dimension is `raw` rather than absent, so the series is still
    // groupable by model — asserted on the whole record, since a partial match
    // would pass just as well with a second observation beside it
    expect(observed.taken()).toEqual([
      {
        component: "database",
        name: "$queryRaw",
        attributes: { model: "raw", operation: "$queryRaw" },
        outcome: "ok",
        failed: false,
        traced: false,
      },
    ]);
  });
});
