---
"@btravstack/amqp-worker": minor
"@btravstack/cache": minor
"@btravstack/config": minor
"@btravstack/contract": minor
"@btravstack/core": minor
"@btravstack/di": minor
"@btravstack/http-server": minor
"@btravstack/mailer": minor
"@btravstack/observability": minor
"@btravstack/prisma": minor
"@btravstack/storage": minor
"@btravstack/temporal-worker": minor
"@btravstack/testing": minor
---

A starter offers its OpenTelemetry instrumentation; composing `otel()` registers it.

`@btravstack/core` declares an `Instrumentations` set port. A package
contributes `{ name, load }`; `@btravstack/observability/otel` loads every
contribution and hands it to the `NodeSDK`. Composing a starter **declares**
what can be instrumented, and composing `otel()` is what turns it on — the
Spring Boot starter shape, in one port.

`@btravstack/prisma` is the first contributor. Engine tracing used to be
enabled while the client was built, whether or not an SDK existed; it is now
offered, so a graph with no `otel()` never loads `@prisma/instrumentation` at
all.

**This does not weaken the preload rule.** `@opentelemetry/auto-instrumentations-node/register`
still has to be preloaded before the libraries it patches are imported, and no
provider can promise that. The rule was always about instrumentations that
patch module loading — one whose `enable()` sets a helper the library reads per
call has no such ordering requirement, and those are what `otel()` registers.

`load` is async and answers `undefined` rather than failing, because the
package supplying the instrumentation is an optional peer the consumer may not
have installed. The contributor logs the skip, since it is the one that knows
why.

`otel()` contributes a member of its own that loads nothing — a collector
depending on a set port nothing provides is an unmet dependency both at plan
time and in `Needs`, and Guice's `newSetBinder` declares the empty set for the
same reason.

`Tracer` leaves `@btravstack/prisma`'s instrumented `needs`. It was there for
ordering, to get the SDK up before the instrumentation was enabled; the SDK now
does the registering, so the ordering is inherent. `Meter` still orders the
client after `otel()`.
