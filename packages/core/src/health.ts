import { Port } from "@btravstack/di";
import {
  Err,
  Ok,
  OkAsync,
  P,
  TaggedError,
  allAsync,
  fromSafePromise,
  type AsyncResult,
  type Result,
} from "unthrown";

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
  /**
   * How long this component gets to answer, overriding the fold's own default.
   *
   * It is on the CONTRIBUTION because only the contributor knows: a `SELECT 1`
   * over a warm pool and an SMTP relay's greeting are two orders of magnitude
   * apart, and one number for both is either a false unhealthy or a probe that
   * outlives the orchestrator's patience. A component with nothing to say about
   * its own latency omits it.
   */
  readonly timeoutMs?: number;
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
 * How long one check gets to answer before it is reported unhealthy, unless a
 * caller says otherwise. Under kubelet's own `timeoutSeconds` default of `1`,
 * so a probe that times out has already been answered from here — with a line
 * naming the component that hung, where the kubelet's timeout names nothing.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 800;

export type HealthOptions = {
  /** Per check, not for the fold: the checks run concurrently. Default {@link DEFAULT_HEALTH_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
};

/**
 * A check that never settles, bounded. `unref`'d, so a pending probe is never
 * the reason a process stays alive, and cleared on the winning branch so a
 * slow-but-answering check leaves no timer behind.
 *
 * It bounds the WAIT, not the check: nothing here can cancel whatever the check
 * is blocked on. That is the same bargain the drain and the stop deadline make,
 * and it is why this reports rather than recovers.
 */
const answeringWithin = (health: HealthCheck, ms: number): AsyncResult<void, HealthCheckFailed> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Result<void, HealthCheckFailed>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve(Err(new HealthCheckFailed({ reason: `did not answer within ${String(ms)} ms` }))),
      ms,
    );
    timer.unref();
  });
  // Started INSIDE the pipeline, so a check that throws synchronously is a
  // defect on this chain rather than an exception escaping the race.
  const answering = OkAsync().flatMap(() => health.check());
  return fromSafePromise(
    Promise.race([answering, timeout]).finally(() => {
      clearTimeout(timer);
    }),
  ).flatMap((settled) => settled);
};

/**
 * Runs every check and folds the results into one report — the whole app is
 * unhealthy if any single component is.
 *
 * Each check's failure is recovered into a component line BEFORE `allAsync`
 * sees it, so a failing dependency cannot short-circuit the others: a report
 * naming one component is worth less than one naming all of them. A check
 * that throws rather than answers is a bug in the check, and it is folded in
 * too: each check is STARTED inside the pipeline, so a synchronous throw and
 * a defecting `AsyncResult` alike are recovered into an unhealthy line —
 * escaped, the first would reach the kernel's own `uncaughtException` handler
 * and the second would leave `/healthz` hanging with nothing written.
 *
 * **A check that never settles is the third case, and it needed a deadline
 * rather than a recovery.** Neither recovery above can see one: there is no
 * error and no defect, only silence, so `/healthz` held a socket open per hit
 * while kubelet timed out against a report that named nothing. Each check now
 * races {@link HealthOptions.timeoutMs}, and the component that hung is named
 * in the report like any other unhealthy one.
 */
export const runHealthChecks = (
  checks: readonly HealthCheck[],
  options: HealthOptions = {},
): AsyncResult<HealthReport, never> =>
  allAsync(
    checks.map((health) =>
      answeringWithin(health, health.timeoutMs ?? options.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS)
        .map((): ComponentHealth => ({ name: health.name, status: "healthy" }))
        .recoverErrCases((matcher) =>
          matcher.with(P.tag("HealthCheckFailed"), (error): ComponentHealth => ({
            name: health.name,
            status: "unhealthy",
            reason: error.reason,
          })),
        )
        .recoverDefect((cause) =>
          Ok<ComponentHealth>({ name: health.name, status: "unhealthy", reason: String(cause) }),
        ),
    ),
  ).map((components) => ({
    status: components.every((c) => c.status === "healthy") ? "healthy" : "unhealthy",
    components,
  }));
