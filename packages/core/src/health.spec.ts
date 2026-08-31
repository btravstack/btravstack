import { ErrAsync, OkAsync, type AsyncResult } from "unthrown";
import { describe, expect, it } from "vitest";

import { HealthCheckFailed, runHealthChecks, type HealthCheck } from "./health.js";

const healthy = (name: string): HealthCheck => ({ name, check: () => OkAsync() });

const failing = (name: string, reason: string): HealthCheck => ({
  name,
  check: () => ErrAsync(new HealthCheckFailed({ reason })),
});

const defecting = (name: string, message: string): HealthCheck => ({
  name,
  check: () =>
    OkAsync().map((): void => {
      // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject: a buggy check whose AsyncResult defects
      throw new Error(message);
    }),
});

const throwing = (name: string, message: string): HealthCheck => ({
  name,
  check: (): AsyncResult<void, HealthCheckFailed> => {
    // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject: a check that throws instead of answering
    throw new Error(message);
  },
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

  it("reports a component whose check defects as unhealthy, instead of losing the report", async () => {
    // GIVEN a healthy component beside one whose check defects
    const checks = [healthy("cache"), defecting("database", "client crashed")];

    // WHEN the checks are folded
    // THEN the buggy check is an unhealthy line naming its cause, and its
    // sibling is still reported — a defect that escaped here would leave
    // `/healthz` hanging with nothing written
    await expect(runHealthChecks(checks)).toBeOkWith({
      status: "unhealthy",
      components: [
        { name: "cache", status: "healthy" },
        { name: "database", status: "unhealthy", reason: "Error: client crashed" },
      ],
    });
  });

  it("contains a check that throws synchronously, instead of letting it escape the fold", async () => {
    // GIVEN a check that throws instead of answering
    // WHEN the checks are folded
    // THEN the throw becomes an unhealthy line rather than escaping to the
    // caller — escaped, it would reach the kernel's uncaughtException handler
    // and tear the application down over its own health endpoint
    await expect(runHealthChecks([throwing("mailer", "bug in the check")])).toBeOkWith({
      status: "unhealthy",
      components: [{ name: "mailer", status: "unhealthy", reason: "Error: bug in the check" }],
    });
  });

  it("reports healthy when nothing declared a check", async () => {
    // GIVEN an application that composed no starter declaring one
    // WHEN the empty list is folded
    // THEN it is healthy with nothing to say, not an error
    await expect(runHealthChecks([])).toBeOkWith({ status: "healthy", components: [] });
  });
});
