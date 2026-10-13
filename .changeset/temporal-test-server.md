---
"@btravstack/temporal-worker": minor
---

`@btravstack/temporal-worker/testing` runs a consumer's specs against a real Temporal server. `temporalServer` is a Vitest `globalSetup` (also the entry's default export) that starts one PostgreSQL and one `temporalio/auto-setup` container per run through `testcontainers`. Its `startupTimeoutMs` option (default five minutes) covers both the health check and the container wait. `temporalEnvironment(prefix)` is a file-scoped fixture that registers a namespace per spec file and answers `{ TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE }` to spread into `boot`'s `env`. `vitest` and `testcontainers` are optional peers of that subpath. Consumers no longer need to depend on `@temporal-contract/testing` or pin its beta.
