---
"@btravstack/prisma": minor
---

A Prisma starter: `DATABASE_URL` bound through `Config`, the Postgres driver
adapter, and a client whose pool is the application scope's.

```ts
const database = prismaDatabase("OrderDatabase")({
  client: (adapter) => new PrismaClient({ adapter }).$extends(unthrownPrisma),
});
```

`database` carries `config`, `port` and a **resourceful** `provider`; a
composition root provides the first two and exports the port, and the pool
closes on every exit path including a boot that fails after it opened.

**The client arrow is the one thing the package cannot own**, and that is the
whole shape of the decision. A Prisma client is generated per application from
its own schema, so there is no client type to ship — which is also why this is
not `@btravstack/database` with an adapter seam. `cache`, `mailer` and
`storage` can have a memory adapter and a real one because their port is a
small fixed interface; a database client is whatever your schema generated, and
an in-memory adapter for arbitrary SQL is not something anyone can write.

`@btravstack/prisma` is therefore the first package here named after a vendor.
The transports are named for their role — `http-server`, `temporal-worker`,
`amqp-worker` — but "database" has no role-shaped surface to name: what varies
is the ORM, and pretending otherwise ships thirteen lines of wiring behind a
package.

It is also the first application-service starter with **no peer on
`@btravstack/core`**. The other three peer on it because their `instrumented`
flag reads `Logger`, `Tracer` and `Meter`; this one ships no instrumentation,
because wrapping every model method of a schema it cannot see is not something
it can do, and a span around `acquire` would time a constructor rather than a
query. Instrumentation belongs in the repository adapters, where
`@unthrown/prisma` already returns a `Result` to hang it on.

Not included, deliberately: migrations (a deployment runs `prisma migrate
deploy` before the process starts; an application that migrates at boot races
its own replicas), transactions (commit boundaries belong to the adapter, and
`$tryTransaction` is already the primitive), a repository base class, and a
health contribution — `/readyz` answers from the kernel's phase and has no hook
to contribute to.

`examples/order-infrastructure` consumes it, so the gate covers it.
