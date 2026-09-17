---
title: "@btravstack/prisma"
description: The complete surface of @btravstack/prisma — prismaDatabase, the client arrow, PrismaLike, the row-level-security and Result subpaths, and what the starter deliberately does not own.
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import { prismaDatabase, type PrismaBinding, type PrismaLike } from "@btravstack/prisma";

// The stand-in for the client YOUR contract types. There is no such type in
// this package, which is the whole point of the `client` arrow.
declare const postgres: (options: PrismaBinding & { readonly contractJson: unknown }) => {
  readonly raw: { readonly sql: unknown };
  readonly runtime: unknown;
};
declare const contractJson: unknown;
-->

# `@btravstack/prisma`

> **Reference.** The Prisma starter: `DATABASE_URL` bound through `Config`, the
> starter's own query middleware, and a client whose pool is the application
> scope's. Prisma **8** — the runtime is `@prisma/orm-postgres`.

## `prismaDatabase(name)({ client })`

```ts
const database = prismaDatabase("OrderDatabase")({
  client: ({ url, middleware }) => postgres({ contractJson, url, middleware }),
});
```

Returns a **module**, augmented with the one thing a composition root needs
from it — the port. Everything else is inside: the provider binding
`DATABASE_URL`, the resourceful provider that opens the pool and closes it
again, and the health member.

```ts
export const PersistenceModule = Module("Persistence")({
  imports: [database],
  exports: [database.port],
  needs: [Env],
});
```

## Exports

| Export                             | What it is                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `prismaDatabase(name)({ client })` | The starter: a `Module` that provides the client port, contributes a health check, and carries `port`.              |
| `database.port`                    | The port your client is reached through, typed by exactly what your `client` arrow returned, with the id you named. |
| `PrismaLike`                       | The constraint on that client: a `raw` lane and a `runtime`, both required to exist and neither described further.  |
| `PrismaBinding`                    | `{ url: string; middleware: readonly SqlMiddlewareLike[] }` — what the starter hands your arrow.                    |
| `PrismaOptions<C>`                 | `{ client: (binding: PrismaBinding) => C }`.                                                                        |
| `SqlMiddlewareLike`                | The structural shape of a Prisma 8 `SqlMiddleware`, as the binding carries it.                                      |

What the module needs is `Env`; what it exports is your port and
`HealthChecks`. A composition root that re-exports it whole passes the second
up to the kernel with no extra line.

## The environment

| Variable       | Required | Default | Semantics                                                                                                                                                                                                                                                     |
| -------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL` | yes      | none    | The connection string, read through `Config.string`. Unset **or blank** is a `ConfigInvalid` naming it, at graph build. Where row security is on, it carries the **application role's** credentials, not the owner's — `prisma db migrate` runs as the owner. |

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
`@prisma/orm-postgres`, and to the [`/result` subpath](#results-on-the-btravstack-prisma-result-subpath)
if you want them as `Result`s.

The health member's own failure is the kernel's `HealthCheckFailed`, carrying
the driver's message, and it reaches `/healthz` rather than the caller.

### `client` — the one thing this package cannot own

A Prisma 8 client is typed by **that application's** emitted `Contract` and
built from **its** `contract.json`, so there is no client type to ship. The
arrow is where your contract and this starter meet, and the port is typed by
exactly what it returns.

It receives the URL, already validated, and the starter's own `middleware`.
Spread that into the client rather than dropping it: it is one `afterQuery`
hook, and it is where the observation below comes from. Add your own middleware
beside it.

This is also why the [`@btravstack/cache`](/reference/cache) shape — a fixed
service type, a memory adapter and a real one — does not apply. `CacheService`
is four methods that two adapters can both satisfy; a database client is
whatever your contract emitted, and an "in-memory adapter" for arbitrary SQL is
not something anyone can write.

### Observation

Every query is handed to whatever contributed to `Observers`, and this module
contributes a no-op member of its own — so a graph composing no observability
owes nothing. There is no flag, as on [`cache`](/reference/cache), `mailer` and
`storage`.

**It is a middleware, not a wrapper.** Prisma 8 has no `$extends` to layer one
over a built client, and needs none: `middleware` is a construction option, and
one `afterQuery` hook sees every query on **every lane** — the ORM's, the SQL
builder's and the raw one — without knowing the contract, which is the thing
this package cannot see. The v7 `$allModels` wrapper saw only the first.

The operation is `component: "database"`, `name: "query"`, dimensioned by the
row count and — when the runtime measured them — its own `latencyMs` and
`source`. `completed` is what settles the outcome, so a failed query is an
error rather than an absence.

Composing [`observability()`](/reference/observability) writes the failed
queries as lines and `otel()` opens the spans and mints the instruments —
neither changes a line of this composition, which is what the set port buys
over a flag that charged three ports for the same behaviour.

### `PrismaLike`

```ts
type Client = PrismaLike;
```

`{ raw: { sql: unknown }; runtime: unknown }` — both required to **exist** and
neither described further. That is deliberate rather than lazy: a parameter is
contravariant, and a real `raw.sql` takes the target's own interpolation union
and its own row-spec type, both narrower than anything a package that cannot
see a contract could name. Spelling them out would refuse every real client.
A client missing either is still a compile error, which is the whole job.

## The pool's lifetime is the scope's

The provider is **resourceful**, so `release` runs on every exit path —
including a boot that fails after it ran. The error channel is empty because
opening cannot fail in the application's terms: Prisma dials on the first
statement, not here.

`runtime().close()` ends the pool without killing the client; Prisma dials
again lazily on the next statement, which is why no test asserts that a
released client refuses to query.

## `Result`s, on the `@btravstack/prisma/result` subpath

Prisma 8 throws, with a **structured** error: `SqlQueryError` carrying a
`sqlState`, and — where the database named one — a `constraint` and a `table`.
`sqlState` is PostgreSQL's own SQLSTATE rather than a vendor code, which is
what makes the mapping portable.

| Export                      | What it is                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `tryQuery(() => query)`     | Runs a query and answers `AsyncResult<T, SqlError>` instead of rejecting. Takes a **thunk**.    |
| `qualify(cause, defect)`    | SQLSTATE → a tagged error, or the caller's defect for anything unmodeled. What `tryQuery` uses. |
| `UniqueConstraintViolation` | SQLSTATE `23505`, carrying `constraint` and `table`.                                            |
| `ForeignKeyViolation`       | SQLSTATE `23503`.                                                                               |
| `NotAuthorized`             | SQLSTATE `42501` — including a write a row-security policy's `WITH CHECK` refused.              |
| `SqlError`                  | The union of the three.                                                                         |

Three arms and no more: a syntax error, a dead connection or a deadlock is
infrastructure a caller cannot act on differently, and belongs on the defect
channel where an unexpected failure already goes.

**`tryQuery` takes a thunk, not a promise.** An `AsyncResult` is eager, so a
promise built at the call site has already started before the Result exists —
the same hazard `unthrown/no-async-result-race` reports one layer up. Passing
the work in unstarted is what keeps a sequence a sequence.

This module imports `unthrown` and **nothing else** — no `@btravstack/*`, no
`@prisma/*` — because it is meant to move to the `unthrown` repository as a
package of its own once Prisma 8 is stable. The error shape it reads is
structural for the same reason.

## Row-level security, on the `@btravstack/prisma/rls` subpath

Two halves, and in Prisma 8 **both are declared**.

### The policy is in the contract

`@@rls` opts a model in and a `policy_<operation>` block declares the rule;
the planner emits `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` like any
other migration operation. No hand-written DDL, and no `@@map` — the wire name
is hashed from the block's contents.

```prisma
model Order {
  id       Int    @id @default(autoincrement())
  tenantId String
  orderId  String

  @@unique([tenantId, orderId])
  @@rls
}

policy_all order_tenant_isolation {
  target    = Order
  using     = "\"tenantId\" = current_setting('app.tenant_id', true)"
  withCheck = "\"tenantId\" = current_setting('app.tenant_id', true)"
}
```

`using` narrows what a statement may see; `withCheck` refuses a write that
would land outside it, as SQLSTATE `42501`. **Without the second argument to
`current_setting(…, true)`**, an unpinned connection errors instead of matching
nothing — the two-argument form returns `NULL`, and `"tenantId" = NULL` is
`NULL`, which is not `true`.

### The pin is a transaction

<!-- doctest: isolate
// The real client, compiled: `OrderDatabaseClient` is what
// `examples/order-infrastructure/src/database.ts` builds from that
// application's own contract, so this fence pins the one thing `rls.test-d.ts`'s
// stand-in cannot — that `tenantPinned` accepts a contract-typed client and
// hands its own transaction context through.
import type { OrderDatabaseClient } from "@btravstack/example-order-infrastructure";

declare const db: OrderDatabaseClient;
declare const tenant: string;
-->

```ts
import { tenantPinned } from "@btravstack/prisma/rls";

const orders = await tenantPinned(db, tenant, (tx) => tx.orm.public.Order.all());
```

| Export                               | What it is                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `tenantPinned(db, tenant, work, o?)` | Runs `work` in a transaction pinned to `tenant`. Answers whatever `work` answers.        |
| `TenantPinnedOptions`                | `{ setting?: string }` — the run-time setting the policy reads, default `app.tenant_id`. |

**It opens a transaction because `set_config(…, true)` is transaction-local**,
and that is the whole design rather than an implementation detail. A
session-scoped pin followed by a separate query works only while the pool
happens to hand back the same connection, and fails silently the first time it
does not — which is exactly the shape a middleware would have taken, and why
there is no middleware here.

The policy must read the **same** setting: a `tenantPinned(db, tenant,
{ setting })` whose policy names a different one denies every row and every
write, which looks exactly like row security working.

Inside the pin the tenant **predicate** leaves that table's reads and writes —
`examples/order-infrastructure`'s `list` names no tenant at all. The **column**
and the **key** stay: `save` still writes `tenantId`, and `find` and `remove`
still address `(tenantId, orderId)`. A policy narrows what a statement may
touch; it does not fill a row in.

This is the **floor**, not the isolation itself: it answers only "did this
statement say which tenant it is for", and the three layers that answer who the
caller is and what they may do are
[Authorize a request](/how-to/authorize-a-request).

### The cost

**One extra round trip and one transaction per unit of work.** Group the
statements that belong together into one `tenantPinned` call rather than
issuing them side by side — which is the same argument for grouping writes into
one transaction, arriving one layer down.

### Two things are still the deployment's

Prisma 8 declares the policy. It does **not** author these, and both leave a
green-looking system: the application works, the tests pass, and no tenant is
isolated from any other.

- **The role must not be the table's owner, and must not bypass RLS.** Prisma 8
  emits `ENABLE ROW LEVEL SECURITY` and has no way to express `FORCE`, which is
  what would make a policy apply to the owner — and the owner is the role that
  ran the migrations. A superuser is exempt whatever a policy says. So a
  deployment connects as a role that is neither:

  ```sql
  CREATE ROLE orders_app NOSUPERUSER NOBYPASSRLS LOGIN PASSWORD '…';
  GRANT CONNECT ON DATABASE orders TO orders_app;
  GRANT USAGE ON SCHEMA public TO orders_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO orders_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO orders_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO orders_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO orders_app;
  ```

  Nothing grants `prisma_contract`, and nothing needs to: the marker recording
  which contract the database is at lives in its own schema, so a role granted
  `public` cannot reach it. Under Prisma 7 the same record was a table IN
  `public`, which a blanket `GRANT … ON ALL TABLES` did reach — and the DDL
  needed a `REVOKE` to take it back.

  `internal/test-infra/src/containers.ts`'s `provisionApplicationRole` runs that
  DDL for this repository's own gate, and
  `examples/order-infrastructure/src/rls.spec.ts` carries "is neither a
  superuser nor exempt from row security" as a standing test — a regression
  handing the owner's URL back is red on its own, without waiting for a policy
  test to notice.

- **The grants are yours.** Prisma 8 authors policies and not `GRANT`s; a role
  with policies and no grant gets a permission error rather than filtered rows.
  Without `GRANT USAGE, SELECT ON ALL SEQUENCES` in particular, an insert into a
  table with an `autoincrement()` column fails on the sequence, with an error
  that reads nothing like an RLS refusal — so the DDL gets debugged in the wrong
  place.

### What a policy does not cover, it is your specs that do

A policy is per table, and the example polices `Order` only. The other two are
deliberate, and each has a reason the policy could not serve:

- **`Customer`** — the `customers` procedures are unmarked, so a request under
  them forks the `anonymous` kind and has no principal to take a tenant from.
  The caller names the tenant on the input, and the adapter reaches it on an
  unpinned client with `where({ tenantId, customerId })`.
- **`OutboxMessage`** — the relay sweeps it **across** tenants, from outside any
  unit, so there is no tenant to pin it to.

Both are therefore **filtered by hand**, and what guards them is
`examples/order-infrastructure/src/prisma-customer-repository.spec.ts`'s "does
not read another tenant's customer" and `src/prisma-outbox.spec.ts`'s "does not
hand one tenant another's pending events" — **two specs, not the database**. A
hand-filter bug on those tables is caught by a test run, not refused by
PostgreSQL, and that is the difference the policy buys on `Order`.

## Not included, deliberately

**Migrations.** A deployment runs `prisma db migrate` against the same database
_before the process starts_ — and, where row security is on, as its **owner**
rather than the role `DATABASE_URL` carries. An application that migrates itself
at boot races every other replica.

**Engine-level tracing.** There is no engine. Prisma 8 is a TypeScript runtime
and ships no instrumentation package, so the `Instrumentations` loader this
starter contributed under Prisma 7 is gone, and with it the `Logger` it needed
for one `debug` line. The `afterQuery` middleware is the whole seam, and it
carries the runtime's own `latencyMs`.

**Transactions.** Commit boundaries belong to the adapter, spelled at the call;
`db.transaction(fn)` is the primitive. The `rls` subpath is not a
counter-example: it opens one transaction to pin a setting on, and the work
inside it is the caller's. There is no unit-scoped transaction and there will
not be one — see
[the kernel maps nothing](/explanation/the-kernel-maps-nothing) and
[scopes and resources](/explanation/scopes-and-resources).

**A repository base class.** Ports are your application's vocabulary, not this
package's.

**A readiness contribution.** The starter _does_ contribute a health check —
`SELECT 1` through the raw lane, named after the starter itself, folded into
`GET /healthz` with nothing wired — but `/readyz` deliberately does not read it.
Failing readiness on a dependency every replica shares removes them all at once,
turning a degraded system into an outage. The kernel reports; an operator
decides.

**Per-query timing as a histogram.** The counter records how a query came out
and the span carries the duration. A histogram would be the natural next thing
to want and is not here yet.
