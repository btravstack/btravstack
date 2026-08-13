/**
 * Multi-binding: a `Port.many` set port that several modules contribute to
 * independently, collected and run together by the composition root. Real
 * examples: a health-check registry (this one), a list of event handlers, a
 * plugin registry. `Context.get` on a set port returns every contribution,
 * accumulated across module boundaries — not just the last one registered.
 */
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { ErrAsync, OkAsync, P, TaggedError, type AsyncResult } from "unthrown";

// `check`, not `name`: `TaggedError`'s payload reserves `name` (along with
// `message`/`stack`) for the class itself (`?: never`), so a domain field
// called `name` cannot carry a value here — it would type as `never`.
export class HealthCheckFailed extends TaggedError("HealthCheckFailed")<{
  readonly check: string;
  readonly reason: string;
}> {}

/**
 * The set port. `Port.many` fixes the *member* shape — what one contribution
 * looks like — while the port's own service, what `Context.get` actually
 * returns, is `readonly HealthCheck[]`: the whole accumulated list.
 */
export class HealthCheck extends Port.many("HealthCheck")<{
  readonly name: string;
  readonly run: () => AsyncResult<"healthy", HealthCheckFailed>;
}> {}

export type HealthReport = {
  readonly name: string;
  readonly status: "healthy" | "unhealthy";
  readonly reason?: string;
};

/**
 * The composition root's own job, not the library's: every contribution
 * runs, and a failing one is folded into the report rather than stopping the
 * rest — a health check that cannot reach its dependency is data the caller
 * wants, not a reason to abandon asking the others.
 */
export const runHealthChecks = (
  checks: ServiceOf<typeof HealthCheck>,
): Promise<readonly HealthReport[]> =>
  Promise.all(
    checks.map((check): Promise<HealthReport> =>
      check.run().match({
        ok: () => ({ name: check.name, status: "healthy" }),
        errCases: (m) =>
          m.with(P.tag("HealthCheckFailed"), (e) => ({
            name: check.name,
            status: "unhealthy" as const,
            reason: e.reason,
          })),
        defect: () => ({
          name: check.name,
          status: "unhealthy" as const,
          reason: "unexpected failure",
        }),
      }),
    ),
  );

/* ── Two plugins, contributing independently ─────────────────────────────
   Neither module imports the other, and neither knows how many other
   contributors to HealthCheck exist — that is the whole point of a set
   port. */

export class Database extends Port("Database")<{
  readonly ping: () => AsyncResult<"healthy", HealthCheckFailed>;
}> {}

export const DatabaseModule = Module("Database")({
  provides: [
    Provider(Database)({ value: { ping: () => OkAsync("healthy") } }),
    Provider.member(HealthCheck)([Database], {
      sync: (db) => ({ name: "database", run: db.ping }),
    }),
  ],
  exports: [Database, HealthCheck],
});

export class Cache extends Port("Cache")<{
  readonly ping: () => AsyncResult<"healthy", HealthCheckFailed>;
}> {}

export const CacheModule = Module("Cache")({
  provides: [
    Provider(Cache)({
      value: {
        ping: () =>
          ErrAsync(new HealthCheckFailed({ check: "cache", reason: "connection refused" })),
      },
    }),
    Provider.member(HealthCheck)([Cache], {
      sync: (cache) => ({ name: "cache", run: cache.ping }),
    }),
  ],
  exports: [Cache, HealthCheck],
});

/**
 * The composition root: re-exports both plugin modules whole, so anything
 * built from `AppModule` can still name `Database`/`Cache` individually if
 * it needs to. `HealthCheck`'s contributions from both land on the one set
 * port regardless of which module declared them.
 */
export const AppModule = Module("App")({
  imports: [DatabaseModule, CacheModule],
  exports: [DatabaseModule, CacheModule],
});
