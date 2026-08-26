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

Health checks: a module declares one, the kernel serves them at `/healthz`.

```json
{
  "status": "unhealthy",
  "components": [
    { "name": "cache", "status": "healthy" },
    {
      "name": "database",
      "status": "unhealthy",
      "reason": "connection refused"
    }
  ]
}
```

`@btravstack/cache`, `@btravstack/storage` and `@btravstack/prisma` each
contribute a check. An application composing them wires nothing: one unhealthy
component makes the whole application unhealthy, and the report names every
component rather than stopping at the first failure.

**`Port.many`/`Provider.member` are back in `@btravstack/di`.** They were
removed because an audit found no consumer — true then, and false as soon as a
second feature wanted the shape. A set port is what lets a starter DECLARE a
check rather than register one: a registry the kernel handed out would
type-check whether or not the call was ever made, so a starter that forgot
would compile and report healthy forever.

A set port nobody contributed to now resolves to `[]` rather than throwing —
the behaviour both di reference pages already documented, and which an
application composing no starter hits immediately.

**`/healthz` does not gate `/readyz`.** Readiness removes a pod from its
Service's endpoints, so failing it on a dependency several replicas share takes
every replica out at once and turns a degraded system into an outage. The
kernel reports; an operator decides what a `503` there means.

`@btravstack/mailer` contributes no check: its port offers only `send`, and a
probe that delivers mail is not a probe. A cheap `verify()` belongs to the SMTP
adapter, and can be added there without changing this shape.

`PrismaLike` now requires `$queryRaw` — every generated Prisma client has it,
and the check needs the server to answer something rather than trusting a
pooled client's idea of "connected".
