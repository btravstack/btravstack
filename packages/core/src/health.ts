import { Port } from "@btravstack/di";
import { P, TaggedError, allAsync, type AsyncResult } from "unthrown";

/**
 * A component could not answer for itself. Modeled rather than thrown, because
 * a health check that throws is a bug in the check; one that fails is the news
 * `/healthz` exists to carry.
 */
export class HealthCheckFailed extends TaggedError("HealthCheckFailed")<{
  readonly reason: string;
}> {}

/** One contribution: what to call the component, and how to ask it. */
export type HealthCheck = {
  readonly name: string;
  readonly check: () => AsyncResult<void, HealthCheckFailed>;
};

/**
 * The set port every starter contributes to and the kernel reads whole.
 *
 * A set port rather than a registry the kernel hands out: a starter DECLARES
 * its check the same way it declares anything else, and a starter an
 * application never composed contributes nothing — no registration call to
 * forget, and no order to get wrong.
 */
export class HealthChecks extends Port.many("HealthChecks")<HealthCheck> {}

export type ComponentHealth = {
  readonly name: string;
  readonly status: "healthy" | "unhealthy";
  /** Present only when the component is unhealthy. */
  readonly reason?: string;
};

export type HealthReport = {
  readonly status: "healthy" | "unhealthy";
  readonly components: readonly ComponentHealth[];
};

/**
 * Runs every check and folds the results into one report — the whole app is
 * unhealthy if any single component is.
 *
 * Each check's failure is recovered into a component line BEFORE `allAsync`
 * sees it, so a failing dependency cannot short-circuit the others: a report
 * naming one component is worth less than one naming all of them. What
 * survives to `allAsync`'s error channel is a `Defect` alone — a check that
 * threw rather than answered, which is a bug in the check.
 */
export const runHealthChecks = (checks: readonly HealthCheck[]): AsyncResult<HealthReport, never> =>
  allAsync(
    checks.map((health) =>
      health
        .check()
        .map((): ComponentHealth => ({ name: health.name, status: "healthy" }))
        .recoverErrCases((matcher) =>
          matcher.with(P.tag("HealthCheckFailed"), (error): ComponentHealth => ({
            name: health.name,
            status: "unhealthy",
            reason: error.reason,
          })),
        ),
    ),
  ).map((components) => ({
    status: components.every((c) => c.status === "healthy") ? "healthy" : "unhealthy",
    components,
  }));
