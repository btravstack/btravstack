---
title: "@btravstack/prisma"
description: The complete surface of @btravstack/prisma — prismaDatabase, the client arrow, PrismaLike, and what the starter deliberately does not own.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Logger } from "@btravstack/core";
import { Module } from "@btravstack/di";
import { prismaDatabase, type PrismaLike } from "@btravstack/prisma";
import { PrismaPg } from "@prisma/adapter-pg";

// The stand-in for the client YOUR schema generates. There is no such type in
// this package, which is the whole point of the `client` arrow.
declare class PrismaClient {
  constructor(options: { readonly adapter: PrismaPg });
  $disconnect(): Promise<void>;
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $extends(extension: unknown): this;
}
declare const unthrownPrisma: unknown;
-->

# `@btravstack/prisma`

> **Reference.** The Prisma starter: `DATABASE_URL` bound through `Config`, the
> Postgres driver adapter, and a client whose pool is the application scope's.

## `prismaDatabase(name)({ client })`

```ts
const database = prismaDatabase("OrderDatabase")({
  client: (adapter) => new PrismaClient({ adapter }).$extends(unthrownPrisma),
});
```

Returns a **module**, augmented with the one thing a composition root needs
from it — the port. Everything else is inside: the provider binding
`DATABASE_URL`, the resourceful provider that opens the pool and closes it
again, the health member, and the loader that turns on engine tracing when an
OpenTelemetry SDK is composed.

```ts
export const PersistenceModule = Module("Persistence")({
  imports: [database],
  exports: [database.port],
  needs: [Env, Logger],
});
```

## Exports

| Export                             | What it is                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `prismaDatabase(name)({ client })` | The starter: a `Module` that provides the client port, contributes a health check and an instrumentation loader, and carries `port`. |
| `database.port`                    | The port your client is reached through, typed by exactly what your `client` arrow returned, with the id you named.                  |
| `PrismaLike`                       | `{ $disconnect(): Promise<void> }` — the constraint on that client, and the whole of it.                                             |
| `PrismaOptions<C>`                 | `{ client: (adapter: PrismaPg) => C }`.                                                                                              |

What the module needs is `Env` and `Logger`; what it exports is your port,
`HealthChecks` and `Instrumentations`. A composition root that re-exports it
whole passes the last two up to the kernel with no extra line.

## The environment

| Variable       | Required | Default | Semantics                                                                                                               |
| -------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | none    | The connection string, read through `Config.string`. Unset **or blank** is a `ConfigInvalid` naming it, at graph build. |

A blank value is a configuration error rather than an absent one — the rule
[`Config`](/reference/config) fixes once for every field, because a deployment
that set the variable to nothing meant to set it to something. The failure is
modeled, so `runMain` prints it and exits **`78`**; nothing crashes on the first
query.

## Errors

There are none of this package's own. The client provider's error channel is
**`never`**: opening cannot fail in the application's terms, because Prisma
dials on the first statement rather than here. What can fail is configuration
(`ConfigInvalid`, above) and the queries themselves — which belong to
`@prisma/client`, and to `@unthrown/prisma` if you want them as `Result`s.

The health member's own failure is the kernel's `HealthCheckFailed`, carrying
the driver's message, and it reaches `/healthz` rather than the caller.

### `client` — the one thing this package cannot own

A Prisma client is **generated per application** from that application's own
schema, so there is no client type to ship. The arrow is where your generated
class and your extensions meet, and the port is typed by exactly what it
returns — including `@unthrown/prisma`'s extension, which belongs here so the
graph holds the extended client rather than a bare one.

It receives the driver adapter, already built from the environment's URL. A
driver other than Postgres is reachable: ignore the adapter passed in and build
your own.

This is also why the [`@btravstack/cache`](/reference/cache) shape — a fixed
service type, a memory adapter and a real one — does not apply. `CacheService`
is four methods that two adapters can both satisfy; a database client is
whatever your schema generated, and an "in-memory adapter" for arbitrary SQL is
not something anyone can write.

### Observation

Every query is handed to whatever contributed to `Observers`, and this module
contributes a no-op member of its own — so a graph composing no observability
owes nothing. There is no flag, as on [`cache`](/reference/cache), `mailer` and
`storage`.

**The operation says `traced: false`**, which is the one thing this component
knows and an observer cannot: engine-level tracing is the `Instrumentations`
loader's job, below, and a client-level span would sit alongside Prisma's own
carrying strictly less. Counting and timing still happen.

```ts
prismaDatabase("OrderDatabase")({
  client: (adapter) => new PrismaClient({ adapter }),
});
```

This works on a client the package cannot see the schema of because Prisma's
`$extends` takes a **`query` component**, and `$allModels.$allOperations`
intercepts every operation on every model. The wrapper is transparent: whatever
the query resolves or rejects with is what the caller receives.

The module needs `Env` and nothing else. Composing
[`observability()`](/reference/observability) writes the failed queries as
lines and `otel()` mints the instruments — neither changes a line of this
composition, which is what the set port buys over a flag that charged three
ports for the same behaviour.

### `PrismaLike`

```ts
type Client = PrismaLike;
```

`{ $disconnect(): Promise<void> }`, and nothing more. A generated client
satisfies it structurally, and so does an extended one, since `$extends`
preserves `$disconnect`.

## The pool's lifetime is the scope's

The provider is **resourceful**, so `release` runs on every exit path —
including a boot that fails after it ran. The error channel is empty because
opening cannot fail in the application's terms: Prisma dials on the first
statement, not here.

`$disconnect` ends the driver adapter's pool without killing the client; Prisma
dials again lazily on the next statement, which is why no test asserts that a
released client refuses to query.

## Engine-level tracing, with no wiring

When **`@prisma/instrumentation` is installed**, the
starter turns on Prisma's own OpenTelemetry instrumentation itself. There is
nothing to import and nothing to compose:

```sh
pnpm add @prisma/instrumentation
```

That traces at the **engine** level — the real SQL, the connection acquisition,
the serialisation — below what a client-level wrapper can reach, which is why
this package emits no span of its own.

`@prisma/instrumentation` is an **optional peer**. An application that does not
install it still gets the counter and the error line, and the skip is stated at
`debug` rather than left silent: telemetry you believe you have and do not is
worse than none.

**It is offered, not registered.** The starter contributes a _loader_ to the
kernel's `Instrumentations` set port; `otel()` is what runs every contribution,
so composing this starter declares engine tracing and composing an SDK turns it
on. A graph with no SDK never imports the package at all — which is why neither
`Tracer` nor `Meter` is in this module's `needs`: the SDK does the registering,
so the ordering that once bought a port dependency is now inherent.

**It can be a provider at all** because `@prisma/instrumentation` patches no
modules: `enable()` sets a helper on `globalThis` under a versioned key and a
client reads it **per query**, so registration order is free. The `--import`
preload rule in [observability](/reference/observability) governs
instrumentations that patch, and does not reach this one.

## Not included, deliberately

**Migrations.** A deployment runs `prisma migrate deploy` against this same URL
_before the process starts_. An application that migrates itself at boot races
every other replica.

**Transactions.** Commit boundaries belong to the adapter, spelled at the call;
`@unthrown/prisma`'s `$tryTransaction` is the primitive. There is no
unit-scoped transaction and there will not be one — see
[the kernel maps nothing](/explanation/the-kernel-maps-nothing) and
[scopes and resources](/explanation/scopes-and-resources).

**A repository base class.** Ports are your application's vocabulary, not this
package's.

**A readiness contribution.** The starter _does_ contribute a health check —
`SELECT 1` through `$queryRaw`, named after the starter itself, folded into
`GET /healthz` with nothing wired — but `/readyz` deliberately does not read it.
Failing readiness on a dependency every replica shares removes them all at once,
turning a degraded system into an outage. The kernel reports; an operator
decides.

**Per-query timing as a histogram.** The counter records how a query came out,
not how long it took; the span carries the duration. A histogram would be the
natural next thing to want and is not here yet.
