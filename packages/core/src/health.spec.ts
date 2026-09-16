import { ErrAsync, OkAsync, fromSafePromise, type AsyncResult } from "unthrown";
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

/** A component that accepts the question and never answers — no error, no defect, only silence. */
const silent = (name: string, timeoutMs?: number): HealthCheck => ({
  name,
  check: () => fromSafePromise(new Promise<void>(() => {})),
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
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

  it("names a component that never answers, instead of waiting on it", async () => {
    // GIVEN a component that accepts the question and goes quiet, beside one
    // that answers — the third failure shape, which neither recovery can see:
    // no error, no defect, only silence
    const checks = [healthy("cache"), silent("database")];

    // WHEN the checks are folded with a deadline a test can afford
    const report = runHealthChecks(checks, { timeoutMs: 5 });

    // THEN the silent component is named and unhealthy, and its sibling still
    // reports — `/healthz` used to hold a socket open per hit while the
    // orchestrator timed out against a report that named nothing
    await expect(report).toBeOkWith({
      status: "unhealthy",
      components: [
        { name: "cache", status: "healthy" },
        { name: "database", status: "unhealthy", reason: "did not answer within 5 ms" },
      ],
    });
  });

  it("lets a contribution declare its own deadline, over the fold's", async () => {
    // GIVEN two silent components, one of which says how long it needs — an
    // SMTP greeting and a `SELECT 1` over a warm pool are orders of magnitude
    // apart, which is why the number is on the contribution
    const checks = [silent("cache"), silent("mailer", 9)];

    // WHEN the fold is given a deadline of its own
    const report = runHealthChecks(checks, { timeoutMs: 4 });

    // THEN each component is named against the deadline that governed it: the
    // fold's for the one that declared nothing, its own for the one that did
    await expect(report).toBeOkWith({
      status: "unhealthy",
      components: [
        { name: "cache", status: "unhealthy", reason: "did not answer within 4 ms" },
        { name: "mailer", status: "unhealthy", reason: "did not answer within 9 ms" },
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
