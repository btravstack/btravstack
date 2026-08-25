---
"@btravstack/temporal-worker": patch
"@btravstack/amqp-worker": patch
---

The two suites that needed a server now share one with the rest of the
repository instead of starting their own.

`@btravstack/amqp-worker` boots against **one RabbitMQ container for the whole gate**
rather than one per vitest run, and `@btravstack/temporal-worker` against **one
Temporal server** with a namespace per spec file, in place of a time-skipping
test server started per vitest worker. Neither suite ever advanced a clock, so
the skippable clock bought nothing a private namespace does not — and
`@btravstack/temporal-worker` no longer downloads a 64 MB binary on a cold cache.

No public surface changes. This is what closed `pnpm test` being
intermittently red at turbo's default concurrency, where five servers for six
workspaces made the 60s testcontainers startup wait the first thing to give
out.
