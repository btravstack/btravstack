---
"@btravstack/core": minor
"@btravstack/observability": minor
"@btravstack/http-server": minor
"@btravstack/temporal-worker": minor
"@btravstack/amqp-worker": minor
"@btravstack/cache": minor
"@btravstack/mailer": minor
"@btravstack/storage": minor
"@btravstack/prisma": minor
---

Observability is a set port now, and the `instrumented` flag is gone from every
package that had one.

`@btravstack/core` declares `Observers`, `observe` and `noObserver`. A starter
reports what it did — an operation, then how it settled — and holds no `Logger`,
`Meter` or `Tracer` of its own. `@btravstack/observability` contributes the
member that writes a failure as a line; `@btravstack/observability/otel`
contributes the one that opens the span and mints
`btravstack.<component>.operations` and `.duration`.

**The three servers gain RED metrics** they never had — rate, errors and
duration per request, delivery and activity attempt, at the unit seam.

**`instrumented` is removed, not deprecated**, from `http()`, `amqp()`,
`temporal()`, `cache()`, `mailer()`, `storage()` and `prismaDatabase()`. It
defaulted to `true` and put three ports in each module's `Needs`, so a root that
wanted a cache and no OpenTelemetry SDK got a compile error naming them and had
to pass an option to turn off something it never asked for. Now every one of
those modules owes nothing beyond its adapter's own needs, and composing
`observability()` and `otel()` is what turns the lines and the instruments on —
with no call site to change.

Two behaviour changes worth knowing:

- **A successful operation writes no log line.** That is what the metric is
  for. `@btravstack/mailer` loses its `info` "mail sent" as a result; an
  application that wants an operator to see every send writes that line where it
  sends.
- **`@btravstack/prisma` needs `Env` and `Logger`** — `Logger` for exactly one
  line, the `debug` saying engine tracing is off because `@prisma/instrumentation`
  is absent. That is a startup fact rather than an operation, so no observer can
  settle it.
