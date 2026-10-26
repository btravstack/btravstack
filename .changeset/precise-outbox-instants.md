---
"@btravstack/outbox": minor
---

Use `Temporal.Instant` for outbox occurrence timestamps, pending reads and
publisher envelopes, preserving PostgreSQL microseconds. The memory store
accepts an optional precise occurrence time and health checks retain
submillisecond lag.

Install the new `temporal-polyfill` peer. Outbox now requires Node 22.12 or
newer so its CommonJS entry can load the ESM polyfill. Replace timestamp
`toISOString()` calls with `toString()` and `getTime()` with
`epochMilliseconds` only at integrations that require millisecond precision.
