---
"@btravstack/start-temporal": minor
---

The Temporal worker runtime for `@btravstack/start-core`.

`temporalRuntime({ connection, taskQueue, workflows, activities, needs })` runs a
Temporal worker under the kernel's lifecycle: one unit per activity attempt, and
a drain that releases the kernel at its **own** deadline rather than Temporal's
`shutdownForceTime` — `@temporalio/worker` exposes no public forced shutdown, so
stopping the wait is the only escalation available, and the worker keeps winding
down underneath until the process exits.

It integrates through `temporal-contract`: add `activityUnits(host)` to
`declareActivitiesHandler`'s middleware and every activity attempt becomes a
kernel unit with the application context injected. `temporal-contract` is not a
peer dependency — the middleware type is structural — and `Result` → activity
failure is deliberately not mapped here, because `declareActivitiesHandler`
already does it.
