import { describe, expect, test } from "vitest";

import { correlationOf } from "./correlation.js";
import { diagnosticPolicy } from "./diagnostics.js";

describe("correlation disclosure", () => {
  test("retains no ambient record outside a unit", () => {
    // GIVEN
    const diagnostics = diagnosticPolicy();
    // WHEN
    const correlation = correlationOf(undefined, diagnostics);
    // THEN
    expect(correlation).toBeUndefined();
  });

  test("keeps legacy correlation when no policy was configured", () => {
    // GIVEN
    const unit = { unitId: "unit", traceId: "trace", tenantId: "tenant" };
    // WHEN
    const correlation = correlationOf(unit);
    // THEN
    expect(correlation).toEqual(unit);
  });

  test("uses the configured projection for canonical correlation fields", () => {
    // GIVEN
    const unit = { unitId: "unit", traceId: "trace", tenantId: "tenant" };
    const diagnostics = {
      ...diagnosticPolicy(),
      attributes: () => ({ unitId: 1, traceId: false, tenantId: 2 }),
    };
    // WHEN
    const correlation = correlationOf(unit, diagnostics);
    // THEN
    expect(correlation).toEqual({ unitId: "[redacted]", traceId: "[redacted]" });
  });

  test("accepts opaque identifiers and rejects malformed or zero trace identifiers", () => {
    // GIVEN
    const diagnostics = diagnosticPolicy();
    // WHEN
    const correlations = [
      {
        unitId: "0192b5b0-0000-7000-8000-000000000001",
        traceId: "1234567890ABCDEF1234567890ABCDEF",
        tenantId: "0192b5b0-0000-7000-8000-000000000002",
      },
      {
        unitId: "person@example.invalid",
        traceId: "00000000000000000000000000000000",
        tenantId: "person@example.invalid",
      },
      { unitId: "unit", traceId: "123", tenantId: "tenant" },
    ].map((unit) => correlationOf(unit, diagnostics));
    // THEN
    expect(correlations).toEqual([
      {
        unitId: "0192b5b0-0000-7000-8000-000000000001",
        traceId: "1234567890ABCDEF1234567890ABCDEF",
        tenantId: "0192b5b0-0000-7000-8000-000000000002",
      },
      { unitId: "[redacted]", traceId: "[redacted]" },
      { unitId: "[redacted]", traceId: "[redacted]" },
    ]);
  });
});
