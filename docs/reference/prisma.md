---
title: "@btravstack/prisma"
description: The complete surface of @btravstack/prisma — prismaDatabase, the client arrow, PrismaLike, the row-level-security subpath, and what the starter deliberately does not own.
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

| Variable       | Required | Default | Semantics                                                                                                                                                                                                                                                         |
| -------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | none    | The connection string, read through `Config.string`. Unset **or blank** is a `ConfigInvalid` naming it, at graph build. Where row security is on, it carries the **application role's** credentials, not the owner's — `prisma migrate deploy` runs as the owner. |

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

The module needs `Env` and `Logger` — the second for exactly one line, the
`debug` saying engine tracing is off because the optional peer is absent, which
is a startup fact rather than an operation an observer could settle. Composing
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

## Row-level security, on the `@btravstack/prisma/rls` subpath

`tenantScoped(tenant, { setting })` is a Prisma client extension that pins
**every** statement — raw SQL included — to `tenant`, through a
transaction-local `set_config('app.tenant_id', tenant, true)`. A PostgreSQL
row-level-security policy reading `current_setting('app.tenant_id', true)` is
then what narrows the query, so an adapter stops naming the tenant in its
`where` at all —
`examples/order-infrastructure/src/prisma-order-repository.ts`'s `list` is the
worked case, and it names none.

It is a **subpath** on the family's optional-peer protocol: `@prisma/client` is
an optional peer, `packages/prisma/src/rls.ts` is the only file that imports it,
and the main entry point never does. A consumer that never writes
`@btravstack/prisma/rls` installs nothing new.

| Export                           | What it is                                                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `tenantScoped(tenant, options?)` | The extension. `options.setting` is the run-time setting the policy reads — default `app.tenant_id`.      |
| `TenantScopedOptions`            | `{ setting?: string }`.                                                                                   |
| `ScopedTransaction`              | The type of the `$transaction` it overrides: the callback form only, `this`-polymorphic so `tx` is typed. |
| `ScopedTransactionClient<C>`     | What that callback's `tx` is — `C` minus Prisma's own transaction deny list.                              |

### Apply it last

<!-- doctest: isolate
// The real chain, compiled. `OrderDatabaseClient` is what
// `examples/order-infrastructure/src/database.ts` builds —
// `new PrismaClient({ adapter }).$extends(unthrownPrisma)` over the client
// THAT application's schema generates — so this fence pins the one thing
// `rls.test-d.ts`'s stand-in cannot: that `tenantScoped` is assignable to a
// generated client's own `$extends`, last in the chain.
import type { OrderDatabaseClient } from "@btravstack/example-order-infrastructure";

declare const unthrownExtendedClient: OrderDatabaseClient;
declare const tenant: string;
-->

```ts
import { tenantScoped } from "@btravstack/prisma/rls";

// `new PrismaClient({ adapter }).$extends(unthrownPrisma)`, and then:
const db = unthrownExtendedClient.$extends(tenantScoped(tenant));
```

`tenantScoped` **last**. Its `$transaction` override runs the callback on a
`tx` taken from the client as it stood when the extension was applied, so
anything added after it is invisible inside a transaction. Measured, with
`tenantScoped` first: `TypeError: tx.order.tryFindMany is not a function`.
`examples/order-infrastructure/src/database.ts`'s `scopedTo` is that order,
written down once.

### `$transaction([...])` is refused

The array form rejects with
`tenantScoped: $transaction([...]) is unsupported — use the callback form.`, and
the `ScopedTransaction` type drops the overload, so it is a compile error first.
It cannot be pinned: the query hook answers a plain `Promise` rather than a
`PrismaPromise`, so every element has already run — each in a wrapping
transaction of its own — before `$transaction` sees the array. Measured, a
failing second element left the first element's row committed where vanilla
Prisma rolled it back. A batch that stops being atomic without saying so is
worse than one that refuses.

### The cost

**One extra round trip and one explicit transaction per statement outside a
transaction.** `set_config(…, true)` is transaction-local and has to be — the
tenant varies per unit while a pooled connection does not — so an unpinned
statement is wrapped in a two-element batch. A statement already inside a
`$transaction` callback pays nothing: the connection is pinned once for the
whole transaction, which is the argument for grouping writes into one rather
than issuing them side by side.

### The database half is the deployment's

The extension pins a setting. Nothing enforces anything until the table has a
policy, and a policy enforces nothing until the connecting role can be subject
to one. Both halves are DDL a deployment writes and neither is checkable from
here. The example's is
`examples/order-infrastructure/prisma/migrations/20260906120000_order_rls/migration.sql`,
hand-written because Prisma's schema language has no policy DDL to generate one
from:

```sql
ALTER TABLE "Order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Order" FORCE ROW LEVEL SECURITY;

-- `current_setting(…, true)` returns NULL rather than erroring when nothing
-- pinned the connection, and `"tenantId" = NULL` is NULL — so an unpinned
-- statement matches no row and inserts nothing.
CREATE POLICY tenant_isolation ON "Order"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
```

And the role the application connects as, which owns nothing:

```sql
CREATE ROLE orders_app NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '…';
GRANT CONNECT ON DATABASE orders TO orders_app;
GRANT USAGE ON SCHEMA public TO orders_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orders_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orders_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orders_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO orders_app;
REVOKE ALL ON "_prisma_migrations" FROM orders_app;
```

`internal/test-infra/src/containers.ts`'s `provisionApplicationRole` runs that
DDL for this repository's own gate — bar the last line, because the gate's
`GRANT … ON ALL TABLES` reaches `_prisma_migrations` like any other table and
the specs have no reason to care. A deployment does: nothing the application
does should be able to rewrite the record of which migrations ran.

### What forgetting each looks like

Both of these are **failures**, and both leave a green-looking system: the
application works, the tests pass, and no tenant is isolated from any other.

- **The role is a superuser.** A superuser bypasses row security whatever
  `FORCE` says, so every policy in the database is a no-op and every query
  answers every tenant's rows. This is not hypothetical: the gate's own
  PostgreSQL container bootstraps as one, which is exactly why
  `internal/test-infra` provisions `orders_app` and why
  `examples/order-infrastructure/src/rls.spec.ts` carries "is neither a
  superuser nor exempt from row security" as a standing test — a regression
  handing the owner's URL back is red on its own, without waiting for a policy
  test to notice.
- **The policy has no `FORCE`.** `ENABLE ROW LEVEL SECURITY` does not apply to
  the table's **owner**, and the owner is the role that ran the migrations. A
  deployment that runs and migrates as one role therefore sees a policy that is
  present, correct, and never consulted.

Two more lines have the same shape, one level down:

- **Without `GRANT USAGE, SELECT ON ALL SEQUENCES`**, an insert into a table
  with an `autoincrement()` column fails on the sequence, with a permission
  error that reads nothing like an RLS refusal — so the DDL gets debugged in
  the wrong place.
- **Without the second argument to `current_setting(…, true)`**, an unpinned
  connection **errors** instead of matching nothing. The two-argument form
  returns `NULL`, and `"tenantId" = NULL` is `NULL`, which is not `true`.

### What a policy does not cover, it is your specs that do

A policy is per table, and the example polices `Order` only. The other two are
deliberate, and each has a reason the policy could not serve:

- **`Customer`** — the `customers` procedures are unmarked, so a request under
  them forks the `anonymous` kind and has no principal to take a tenant from.
  The caller names the tenant on the input, and the adapter reaches it through
  the raw client with `where: { tenantId_customerId: … }`.
- **`OutboxMessage`** — the relay sweeps it **across** tenants, from outside any
  unit, so there is no tenant to pin it to.

Both are therefore **filtered by hand**, and what guards them is
`examples/order-infrastructure/src/prisma-customer-repository.spec.ts`'s "does
not read another tenant's customer" and `src/prisma-outbox.spec.ts`'s "does not
hand one tenant another's pending events" — **two specs, not the database**. A
hand-filter bug on those tables is caught by a test run, not refused by
PostgreSQL, and that is the difference the policy buys on `Order`.

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

**Migrations.** A deployment runs `prisma migrate deploy` against the same
database _before the process starts_ — and, where row security is on, as its
**owner** rather than the role `DATABASE_URL` carries. An application that
migrates itself at boot races every other replica.

**Transactions.** Commit boundaries belong to the adapter, spelled at the call;
`@unthrown/prisma`'s `$tryTransaction` is the primitive. The `rls` subpath's
`$transaction` override is not a counter-example: it pins the tenant on the
connection its callback runs over and opens no boundary of its own. There is no
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
