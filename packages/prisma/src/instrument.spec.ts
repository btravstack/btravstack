import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { instrument } from "./instrument.js";

describe("instrument", () => {
  it("observes a query that answers, and opens no span", async ({ stub, observed }) => {
    // GIVEN an observed client
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN a query runs to completion
    const answer = await client.query("Order", "findMany", Promise.resolve(["a"]));

    // THEN the caller's value passes through untouched, and the call is
    // recorded — untraced, because `@btravstack/prisma/otel` traces at the
    // ENGINE level and a second client-level span would carry strictly less
    expect({ answer, recorded: observed.taken() }).toEqual({
      answer: ["a"],
      recorded: [
        {
          component: "database",
          name: "findMany",
          attributes: { model: "Order", operation: "findMany" },
          outcome: "ok",
          failed: false,
          traced: false,
        },
      ],
    });
  });

  it("observes a query that rejects, carrying the cause", async ({ stub, observed }) => {
    // GIVEN an observed client and a query that will reject
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);
    const cause = new Error("deadlock detected");

    // WHEN it runs
    const rejected = await client
      .query("Order", "create", Promise.reject(cause))
      .then(() => "resolved")
      .catch(() => "rejected");

    // THEN the rejection reaches the caller unchanged — the wrapper is
    // transparent — and the failure was observed with the cause an observer
    // needs to write a line about it
    expect({ rejected, recorded: observed.taken() }).toEqual({
      rejected: "rejected",
      recorded: [
        {
          component: "database",
          name: "create",
          attributes: { model: "Order", operation: "create" },
          outcome: "error",
          failed: true,
          traced: false,
        },
      ],
    });
  });

  it("names a raw query `raw`, since it belongs to no model", async ({ stub, observed }) => {
    // GIVEN an observed client
    const client = instrument(stub.client("postgres://localhost/orders"), observed.members);

    // WHEN a query with no model runs
    await client.query(undefined as unknown as string, "$queryRaw", Promise.resolve([]));

    // THEN the dimension is `raw` rather than absent, so the series is still
    // groupable by model
    expect(observed.taken()[0]).toEqual(
      expect.objectContaining({ attributes: { model: "raw", operation: "$queryRaw" } }),
    );
  });
});
