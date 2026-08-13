# plugin-registry

Multi-binding: a `Port.many` health-check registry fed independently by two
modules, collected and run together at the composition root.

```sh
pnpm --filter @btravstack/di-example-plugin-registry test
pnpm --filter @btravstack/di-example-plugin-registry typecheck
```

## What it shows

`src/index.ts`, top to bottom:

- **A set port, not an ordinary one.** `HealthCheck` is declared with
  `Port.many`, so `Context.get(HealthCheck)` returns `readonly HealthCheck[]`
  — every contribution — rather than a single service. Two ordinary
  providers targeting the same port would be a wiring defect; two
  `Provider.member` contributions to the same set port are the intended
  shape.
- **Contributions from modules that do not know about each other.**
  `DatabaseModule` and `CacheModule` each contribute one member with
  `Provider.member(HealthCheck)(...)`. Neither imports the other, and
  neither has to know how many other contributors exist — `AppModule` simply
  imports both and re-exports them.
- **A composition-root concern, not the library's.** `runHealthChecks` folds
  every contribution's result into a report, deliberately never
  short-circuiting on the first failure — a health check that cannot reach
  its dependency is data the caller wants back, not a reason to stop asking
  the rest. That is ordinary application code built _on_ `@btravstack/di`,
  not something the library does for you.

## What the spec proves

- **Contributions accumulate across module boundaries.** `AppModule` never
  declares a `HealthCheck` provider itself — every member the built context
  returns came from `DatabaseModule` or `CacheModule`, and the first test
  asserts both are present, not just one.
- **A failure is reported, not thrown.** `CacheModule`'s check models an
  unreachable cache as an `Err`; the second test asserts `runHealthChecks`
  turns that into an `"unhealthy"` report alongside the database's
  `"healthy"` one — the failure never aborts the run.
- **The registry keeps growing without touching what already contributes.**
  The third test wires a brand-new `QueueModule` alongside the untouched
  `AppModule` and gets three contributions back, proof that adding a
  plugin is purely additive.
