---
title: "@btravstack/prisma"
description: The complete surface of @btravstack/prisma — prismaDatabase, the client arrow, PrismaLike, and what the starter deliberately does not own.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Logger, Meter, Tracer } from "@btravstack/core";
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

Returns three pieces, and a composition root wants all three:

| Piece      | What it is                                                            |
| ---------- | --------------------------------------------------------------------- |
| `config`   | The provider binding the connection string from the environment.      |
| `port`     | The port the client is reached through, typed by your `client` arrow. |
| `provider` | The **resourceful** provider that opens the pool and closes it again. |

```ts
export const PersistenceModule = Module("Persistence")({
  imports: [database],
  exports: [database.port],
  needs: [Env, Logger, Meter, Tracer],
});
```

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
knows and an observer cannot: engine-level tracing is `prismaTracing()`'s job,
below, and a client-level span would sit alongside Prisma's carrying strictly
less. Counting and timing still happen.

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

**`Tracer` is depended on for its ordering, not its value.** Nothing reads it,
but `otel()` sets the global tracer provider while building that very port, so
naming it is what guarantees the SDK is up first. A root without `otel()` gets a
compile error instead of tracing into nothing.

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

**A health contribution.** `/readyz` answers from the kernel's phase, and there
is no hook to contribute to. Adding one is a kernel change and a contested one:
a pod that cannot reach its database arguably should stay ready and fail
requests rather than flap out of the endpoint list.

**Per-query timing as a histogram.** The counter records how a query came out,
not how long it took; the span carries the duration. A histogram would be the
natural next thing to want and is not here yet.
