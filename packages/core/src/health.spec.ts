import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect, it } from "vitest";

import { HealthCheckFailed, runHealthChecks, type HealthCheck } from "./health.js";

const healthy = (name: string): HealthCheck => ({ name, check: () => OkAsync() });

const failing = (name: string, reason: string): HealthCheck => ({
  name,
  check: () => ErrAsync(new HealthCheckFailed({ reason })),
});

describe("runHealthChecks", () => {
  it("reports healthy when every component answers", async () => {
    // GIVEN two components that both answer
    // WHEN the checks are folded
    // THEN the whole application is healthy, and each component is named
    await expect(runHealthChecks([healthy("cache"), healthy("database")])).toBeOkWith({
      status: "healthy",
      components: [
        { name: "cache", status: "healthy" },
        { name: "database", status: "healthy" },
      ],
    });
  });

  it("reports the whole application unhealthy when one component fails", async () => {
    // GIVEN a healthy component either side of a failing one
    const checks = [healthy("cache"), failing("database", "connection refused"), healthy("mailer")];

    // WHEN the checks are folded
    // THEN the app is unhealthy, the failure carries its reason, and the
    // components AFTER the failure are still reported — a report naming one
    // component would be worth less than one naming all of them
    await expect(runHealthChecks(checks)).toBeOkWith({
      status: "unhealthy",
      components: [
        { name: "cache", status: "healthy" },
        { name: "database", status: "unhealthy", reason: "connection refused" },
        { name: "mailer", status: "healthy" },
      ],
    });
  });

  it("reports healthy when nothing declared a check", async () => {
    // GIVEN an application that composed no starter declaring one
    // WHEN the empty list is folded
    // THEN it is healthy with nothing to say, not an error
    await expect(runHealthChecks([])).toBeOkWith({ status: "healthy", components: [] });
  });
});
