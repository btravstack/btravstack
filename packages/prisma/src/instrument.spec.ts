import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { instrument } from "./instrument.js";

describe("instrument", () => {
  it("spans and counts a query that answers", async ({ stub, telemetry }) => {
    // GIVEN an instrumented client
    const client = instrument(
      stub.client("postgres://localhost/orders"),
      telemetry.logger,
      telemetry.tracer,
      telemetry.meter,
    );

    // WHEN a query runs to completion
    const answer = await client.query("Order", "findMany", Promise.resolve(["a"]));

    // THEN the caller's value passes through untouched, and the call is recorded
    expect({ answer, ...telemetry.recorded() }).toEqual(
      expect.objectContaining({
        answer: ["a"],
        spans: [
          {
            name: "db.Order.findMany",
            attributes: {
              "btravstack.database.model": "Order",
              "btravstack.database.operation": "findMany",
            },
            failed: false,
          },
        ],
        counts: [
          { value: 1, attributes: { model: "Order", operation: "findMany", outcome: "ok" } },
        ],
        errors: [],
      }),
    );
  });

  it("marks the span and logs when a query rejects", async ({ stub, telemetry }) => {
    // GIVEN an instrumented client and a query that will reject
    const client = instrument(
      stub.client("postgres://localhost/orders"),
      telemetry.logger,
      telemetry.tracer,
      telemetry.meter,
    );
    const cause = new Error("deadlock detected");

    // WHEN it runs
    const rejected = await client
      .query("Order", "create", Promise.reject(cause))
      .then(() => "resolved")
      .catch((thrown: unknown) => thrown);

    // THEN the rejection still reaches the caller, and the failure is recorded
    expect({ rejected, ...telemetry.recorded() }).toEqual(
      expect.objectContaining({
        rejected: cause,
        spans: [expect.objectContaining({ name: "db.Order.create", failed: true })],
        counts: [
          { value: 1, attributes: { model: "Order", operation: "create", outcome: "error" } },
        ],
        errors: [
          {
            message: "a database query failed",
            attributes: { model: "Order", operation: "create" },
          },
        ],
      }),
    );
  });
});
