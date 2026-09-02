---
"@btravstack/temporal-worker": minor
---

`@btravstack/temporal-worker/schedule` ships `ensureSchedule` — the typed
schedule client's `create`, made idempotent. A deploy runs again on every
release, and `create` answers `ScheduleAlreadyExistsError`; this recovers that
one error into an `update` and leaves every other on the channel, still typed.
It writes the spec and not the state, so a schedule an operator paused stays
paused. `@temporal-contract/client` is an optional peer, reached only through
the subpath.
