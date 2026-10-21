import { OkAsync, allAsync, type AsyncResult } from "unthrown";

import type { Clock } from "./clock.js";
import { runHealthChecks, type HealthCheck, type HealthReport } from "./health.js";

const cachedCheck = (
  check: HealthCheck,
  clock: Clock,
): (() => AsyncResult<HealthReport, never>) => {
  const interval = typeof check.readiness === "object" ? check.readiness.intervalMs : 1000;
  let cached: HealthReport | undefined;
  let expiresAt = 0;
  let pending: AsyncResult<HealthReport, never> | undefined;
  return () => {
    if (!Number.isFinite(interval) || interval <= 0) {
      return OkAsync({
        status: "unhealthy",
        components: [
          {
            name: check.name,
            status: "unhealthy",
            reason: "readiness interval must be a positive finite number",
          },
        ],
      });
    }
    if (cached !== undefined && clock.now() < expiresAt) return OkAsync(cached);
    // Cache the bounded report, rather than the dependency's potentially
    // never-settling operation, so a timeout can recover on the next interval.
    pending ??= runHealthChecks([check]).map((report) => {
      cached = report;
      expiresAt = clock.now() + interval;
      pending = undefined;
      return report;
    });
    return pending;
  };
};

/** Per-application checks; only readiness contributors retain a cached report. */
export const healthMonitor = (checks: readonly HealthCheck[], clock: Clock) => {
  const entries = checks.map((check) => ({
    readiness: Boolean(check.readiness),
    run: check.readiness ? cachedCheck(check, clock) : () => runHealthChecks([check]),
  }));
  return {
    health: (): AsyncResult<HealthReport, never> =>
      allAsync(entries.map((entry) => entry.run())).map((reports) => ({
        status: reports.every((report) => report.status === "healthy") ? "healthy" : "unhealthy",
        components: reports.flatMap((report) => report.components),
      })),
    readiness: (): AsyncResult<boolean, never> =>
      allAsync(entries.filter((entry) => entry.readiness).map((entry) => entry.run())).map(
        (reports) => reports.every((report) => report.status === "healthy"),
      ),
  };
};
