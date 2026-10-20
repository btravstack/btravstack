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

## Supported Prisma trains

The `@prisma/orm-postgres` peer is `^8.0.0-rc.11`. Both Prisma 8 trains it
admits are tested:

| Train  | `@prisma/orm-postgres` | `prisma` CLI  | `@prisma/cli-engine` | Tested by                                                        |
| ------ | ---------------------- | ------------- | -------------------- | ---------------------------------------------------------------- |
| Floor  | `8.0.0-rc.11`          | `8.0.0-rc.15` | `0.4.0`              | `internal/prisma-floor`: migrations released under it, unedited  |
| Latest | `8.0.0-rc.18`          | `8.0.0-rc.23` | `0.7.0`              | the rest of the gate, including the order infrastructure example |

The starter's middleware carries the hooks of both: `beforeQuery` /
`afterQuery` / `beforeExecute` / `afterExecute` up to rc.17, and
`beforeEncode` / `activityEnded` from rc.18. Each runtime calls only its own.
Upgrading `@btravstack/prisma` therefore never requires upgrading Prisma.

### Upgrading `@btravstack/prisma` with released migrations

Upgrade `@btravstack/prisma` and its `@btravstack/*` peers. Keep the Prisma
packages where they are. No contract, migration, snapshot or database marker
changes, and `prisma db verify` keeps passing against the databases that
already applied them. An application on `@btravstack/prisma` 0.44.0, which
required rc.18, can return to rc.11 the same way.

### Upgrading Prisma itself

Upgrading Prisma is a separate decision, on your own schedule. It is not
reversible for released migrations. The rc.15 toolchain stores a column's data
type (`dataType`) instead of its database type name (`nativeType`), and later
toolchains refuse an older snapshot:
`contracts no longer store a column's database type name`. Prisma's only
path is the `data-type-in-contract` script in its shipped upgrade notes
(`@prisma/orm-postgres/skills/prisma-8/upgrading/`). It rewrites every stored
contract, renames the snapshot directories to the new storage hashes, and
rewrites each migration's `migrationHash`, the refs and every `migration.ts`.
Every database then needs `prisma db sign`: until then `db migrate` fails with
`MIGRATION.MARKER_MISMATCH` and `db verify` exits `4`.

An application whose released migrations are never edited stays on the floor
train until Prisma offers a path that keeps them. One that accepts the rewrite
follows Prisma's notes for every step from its version to the latest. Three of
those steps change what the application writes: from rc.12 a model's table
name keeps its case unless `@@map` names it, from rc.14 the Postgres package
requires `temporal-polyfill@^1.0.4` as a peer, and from rc.18 a policy's
`using` and `withCheck` (like `@@index(where:)` and `@@check(expression:)`) are
`sql` literals.

## Production dependency closure

The pinned Prisma 8 Postgres facade has **no supported toolchain-free
production install**. Importing `@prisma/orm-postgres/runtime` selects the
runtime JavaScript entry point; it does not select a smaller package manifest.
The [published Postgres manifest](https://registry.npmjs.org/@prisma/orm-postgres/8.0.0-rc.18)
requires `@prisma/orm-toolchain`, whose
[published manifest](https://registry.npmjs.org/@prisma/orm-toolchain/8.0.0-rc.18)
requires the `@prisma/cli-engine` peer and declares build-tool dependencies.

Keep the application manifest split by responsibility:

| Manifest section  | Packages                                                                                                    | Purpose                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `dependencies`    | `@btravstack/prisma`, its required framework peers, `unthrown`, `@prisma/orm-postgres`, `temporal-polyfill` | Boot the typed client from the emitted contract and retain the starter's connection, role and teardown checks.        |
| `devDependencies` | `prisma`, `@prisma/cli-engine`, TypeScript and the application's compiler                                   | Emit contracts and compile in the build stage; run migrations and verification in a separate deployment image or Job. |

This is the split the order infrastructure example uses. It does **not** make
Prisma's transitive toolchain development-only: a frozen, strict-peer
`pnpm deploy --prod` still includes the dependencies and resolved peers of
production packages. A minimal reproduction with only the Postgres facade as
an application dependency includes the toolchain, CLI engine, TypeScript,
esbuild and Prettier in the deployed tree even when the application's direct
CLI-engine and TypeScript entries are development dependencies.

Keep peer validation enabled. Removing the starter's required Prisma peer,
using a subpath, or changing the application's direct tooling entries cannot
remove that upstream dependency. Deleting transitive packages after deployment
or weakening peer checks is not a supported runtime surface.

The upstream dependency is tracked by
[btravstack #561](https://github.com/btravstack/btravstack/issues/561).
[Prisma #30437](https://github.com/prisma/orm/issues/30437) tracks the related
CLI-engine coupling through `orm-toolchain` for Composer; its scope does not
yet establish a runtime-only Postgres facade. The required upstream change is
a published runtime dependency surface that consumes emitted contracts without
requiring the authoring toolchain or its CLI-engine peer.

Once that surface is published, validation must emit and typecheck the contract
in a build stage, deploy the frozen production closure with strict peers, and
boot it against PostgreSQL as a non-owner role in a non-root distroless Node
image. The closure must contain no compiler, bundler or formatter binaries.
Until then, a distroless image can omit a shell and package manager, but this
starter cannot promise that its installed Prisma dependency tree contains no
build tooling. `prismaDatabase` continues to probe the database, refuse
row-security-bypassing roles and close the pool; those guarantees do not depend
on contract emission or migrations running inside the application process.

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
| `DatabaseUnreachable`              | The startup error when the database does not answer as the scope opens: `{ database, cause }`.                      |
| `RowSecurityBypassed`              | The startup error when row security would not apply to the role: `{ database, role, bypass, tables }`.              |
| `RowSecurityBypass`                | `"superuser" \| "bypassrls" \| "owner"` — why it would not, as `bypass` carries it.                                 |

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

Two of this package's own, at startup. Opening the scope runs the health
check's probe before the client is handed out, so a database that does not
answer fails the boot with **`DatabaseUnreachable`** — `database` is the name
you gave, `cause` the driver's own failure, and the URL is never in it, since
it holds credentials. The wait is bounded by your pool's
`connectionTimeoutMillis` (Prisma's default is twenty seconds), set in your
`client` arrow. It is the same posture as
[`@btravstack/cache`](/reference/cache)'s Redis adapter and the AMQP and
Temporal clients: a dependency the process cannot reach fails the boot rather
than its first request.

Then, where any table has row-level security enabled, it asks whether that
security applies to the role it connected as, and fails the boot with
**`RowSecurityBypassed`** when it does not: the role is a superuser, has
`BYPASSRLS`, or owns — directly or through a role whose privileges it
inherits — a row-secured table that is not `FORCE`d. `role` is the role,
`bypass` which of the three, and `tables` every table it would bypass. Every
policy would admit every row for such a role, so serving would look exactly
like working isolation; _Two things are still the deployment's_, below, is
the split that avoids it. A database with no row-secured table is asked
nothing more, and the check is not repeated by the health member: it is a fact
about the deployment's credentials, settled once.

A contract marker that does not match is **not** one of them. Prisma 8 checks
the marker on that first statement and, on a mismatch, logs a warning once and
carries on; `prisma db verify` is the deploy-time check that fails.

Everything else is configuration (`ConfigInvalid`, above) and the queries
themselves — which belong to `@prisma/orm-postgres`, and to the
[`/result` subpath](#results-on-the-btravstack-prisma-result-subpath) if you
want them as `Result`s.

The health member's own failure is the kernel's `HealthCheckFailed`, carrying
the driver's message, and it reaches `/healthz` rather than the caller.

### `client` — the one thing this package cannot own

A Prisma 8 client is typed by **that application's** emitted `Contract` and
built from **its** `contract.json`, so there is no client type to ship. The
arrow is where your contract and this starter meet, and the port is typed by
exactly what it returns.

It receives the URL, already validated, and the starter's own `middleware`.
Spread that into the client rather than dropping it: it carries the statement
hooks of every supported Prisma train, and it is where the observation below
comes from. Add your own middleware
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
a hook sees every statement on **every lane** — the ORM's, the SQL builder's and
the raw one — without knowing the contract, which is the thing this package
cannot see. The v7 `$allModels` wrapper saw only the first.

**The operation opens before the driver runs and settles after it**, so a span
an observer opens is one the statement runs _inside_. From rc.18 it opens in
`beforeEncode` and settles in `activityEnded`, its finisher held in the
activity's own `ctx.state`; transaction activities are ignored, and a statement
refused before encoding opens nothing. Up to rc.17 it opens in `beforeQuery` or
`beforeExecute` and settles in `afterQuery` or `afterExecute`, paired by
`ctx.planExecutionId`. Either way both lanes are observed: a write with no
`RETURNING`, run through `runtime().execute(plan)`, never reaches the query
hooks, and overlapping statements settle independently.

The operation is `component: "database"`, `name: "query"`, with `scope`
(`runtime` / `connection` / `transaction`) and `source` (`driver` /
`middleware`) as its dimensions — both closed sets — and the rendered statement
on `details`, where an unbounded value rides the span and the failure line but
never an instrument. The row count is deliberately absent: it is unbounded, and
one time series per row count is how a metrics bill becomes the incident.

The statement's outcome settles the observation (`outcome: "succeeded"` from
rc.18, `completed: true` before it), and a failed statement does reach the
hook — measured against a real database, a duplicate insert arrives as a
failure before the rejection surfaces. A statement whose reader stopped early
(`outcome: "stopped"`, rc.18 only) settles as an error.

**Prisma 8 ships no OpenTelemetry instrumentation of its own**, so this is the
whole seam rather than a second one. There is no `@prisma/instrumentation`
successor: nothing in `@prisma/orm-postgres`, `@prisma/orm-family-sql` or
`@prisma/orm-framework` references OpenTelemetry at all. Composing
`@btravstack/observability/otel` is what turns these operations into spans and
instruments.

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
including a boot that fails after it ran. A probe that fails closes the pool
itself, since nothing was acquired for `release` to close.

`runtime().close()` ends the pool without killing the client; Prisma dials
again lazily on the next statement, which is why no test asserts that a
released client refuses to query.

**The pool is verified before any unit runs on it.** Prisma 8 verifies its
contract marker on first use, on a connection of its own. On a fresh pool whose
first statements are a burst of transactions — as many as it has connections —
every connection is held by a transaction waiting on that check, the check never
gets one, and the whole burst times out. Running the probe while the scope opens
takes that first use off the request path, whatever the pool size; a fresh
scope serving twenty-five concurrent transactions on Prisma's default pool of
ten is pinned by `examples/order-infrastructure`'s `database.spec.ts`.

### Pool size and timeouts are the URL's, or your pool's

The starter takes no pool or timeout options, because each is already
expressible below it and a second spelling would have to agree with the first.

**Statement, lock and idle-in-transaction timeouts ride the URL.** The driver
copies every query parameter of `DATABASE_URL` into its connection settings
and sends `statement_timeout`, `lock_timeout` and
`idle_in_transaction_session_timeout` as startup parameters of every session
the pool opens:

```text
postgresql://orders_app:…@db:5432/orders?statement_timeout=5000&lock_timeout=2000&idle_in_transaction_session_timeout=10000
```

Each value is read with `parseInt`, so it is **milliseconds as a bare
integer** — `5s` would arrive as `5`. Anything else PostgreSQL accepts at
startup goes through libpq's `options` (`?options=-c%20work_mem%3D64MB`), and a
setting that belongs to the role rather than the deployment is
`ALTER ROLE orders_app SET statement_timeout = '5s'`, which then needs no URL
at all. A statement timeout cancels with SQLSTATE `57014` and a lock timeout
with `55P03`, neither of which `tryQuery` models, so both reach the defect
channel; an idle-in-transaction timeout ends the session itself.

**The pool's size is a pool you build.** Prisma 8 forwards only
`poolOptions.connectionTimeoutMillis` and `idleTimeoutMillis`; for `max`, or
anything else `pg.Pool` takes, construct one in the `client` arrow from the URL
the starter bound and pass it as `pg` — `Pool` from the `pg` package, which you
install beside `@prisma/orm-postgres`:

<!-- doctest: isolate
import { prismaDatabase, type PrismaBinding } from "@btravstack/prisma";

declare class Pool {
  constructor(config: { readonly connectionString: string; readonly max: number; readonly connectionTimeoutMillis: number });
}
declare const postgres: (options: Pick<PrismaBinding, "middleware"> & { readonly contractJson: unknown; readonly pg: Pool }) => {
  readonly raw: { readonly sql: unknown };
  readonly runtime: unknown;
};
declare const contractJson: unknown;
-->

```ts
const database = prismaDatabase("OrderDatabase")({
  client: ({ url, middleware }) =>
    postgres({
      contractJson,
      middleware,
      pg: new Pool({ connectionString: url, max: 20, connectionTimeoutMillis: 5_000 }),
    }),
});
```

**The starter still ends that pool.** Prisma's own `db.close()` leaves a pool
it did not construct alone, but the starter's `release` is
`runtime().close()`, which closes the driver, and the driver's `close()` is
`pool.end()` for a pool it was handed as much as for one it built. So the
pool's lifetime stays the scope's either way; do not end it yourself.

## `Result`s, on the `@btravstack/prisma/result` subpath

Prisma 8 throws, with a **structured** error: `SqlQueryError` carrying a
`sqlState`, and — where the database named one — a `constraint` and a `table`.
`sqlState` is PostgreSQL's own SQLSTATE rather than a vendor code, which is
what makes the mapping portable.

| Export                       | What it is                                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `tryQuery(() => query, o?)`  | Runs a query and answers `AsyncResult<T, SqlError>` instead of rejecting. Takes a **thunk**.    |
| `qualify(cause, defect, o?)` | SQLSTATE → a tagged error, or the caller's defect for anything unmodeled. What `tryQuery` uses. |
| `UniqueConstraintViolation`  | SQLSTATE `23505`, carrying `constraint` and `table`.                                            |
| `ForeignKeyViolation`        | SQLSTATE `23503`.                                                                               |
| `NotAuthorized`              | SQLSTATE `42501` — including a write a row-security policy's `WITH CHECK` refused.              |
| `SqlError`                   | The union of the three.                                                                         |
| `RaisedException<S>`         | A SQLSTATE listed in `raises`: `{ sqlState: S, message, constraint, table }`.                   |
| `Raised<S>`                  | One `RaisedException` per listed code, and `never` when none is.                                |
| `QualifyOptions<S>`          | `{ raises?: readonly S[] }` — the option both functions take.                                   |

Three arms by default: a syntax error, a dead connection or a deadlock is
infrastructure a caller cannot act on differently, and belongs on the defect
channel where an unexpected failure already goes.

**A refusal the application raises on purpose is the exception, and it is
opt-in.** A trigger guarding what the schema cannot express — `RAISE EXCEPTION
'…' USING ERRCODE = 'OR001'` — refuses with a code of the application's own,
and the adapter is the one place that can name it. List it in `raises` and it
arrives as `RaisedException<"OR001">`, carrying the code, the message the
`RAISE` wrote, and the constraint and table where the database named them:

<!-- doctest: isolate
import { tryQuery } from "@btravstack/prisma/result";
import { P } from "unthrown";

declare const db: { readonly orm: { readonly orders: { readonly Order: { readonly create: (row: { readonly orderId: string; readonly quantity: number }) => Promise<unknown> } } } };
declare const row: { readonly orderId: string; readonly quantity: number };
declare const frozen: () => Error;
-->

```ts
const saved = tryQuery(() => db.orm.orders.Order.create(row), {
  raises: ["OR001"],
}).mapErrCases((matcher, defect) =>
  matcher
    .with(P.tag("RaisedException"), () => frozen())
    .with(
      P.tag("UniqueConstraintViolation"),
      P.tag("ForeignKeyViolation"),
      P.tag("NotAuthorized"),
      (cause) => defect(cause),
    ),
);
```

Listing nothing adds nothing — the channel stays the three arms, so every
exhaustive match written without the option compiles unchanged — and each
listed code is an arm of its own, so a match that forgets one does not compile.
An unlisted code is still a defect, and a listed code the three arms already
model keeps its own arm. `tenantPinned` takes the same option.

**Raise in a class of your own, not in `XX`.** PostgreSQL reserves `XX` for
its internal errors (`XX000`, `XX001` data corruption), and `P0001` is what a
bare `RAISE EXCEPTION` uses, so neither says "this guard". Any class the
[SQLSTATE table](https://www.postgresql.org/docs/current/errcodes-appendix.html)
does not use — five characters of digits and upper-case letters — is yours.

**`tryQuery` takes a thunk, not a promise.** An `AsyncResult` is eager, so a
promise built at the call site has already started before the Result exists —
the same hazard `unthrown/no-async-result-race` reports one layer up. Passing
the work in unstarted is what keeps a sequence a sequence.

This module imports `unthrown` and **nothing else** — no `@btravstack/*`, no
`@prisma/*` — because it is meant to move to the `unthrown` repository as a
package of its own once Prisma 8 is stable. The error shape it reads is
structural for the same reason.

## Give the application a namespace of its own

Declare your models inside a `namespace <name> { … }` block rather than letting
them fall into `public`. The migration then emits `CREATE SCHEMA`, the tables
land in it, and every query reads `db.orm.<name>.<Model>`.

**Not for the reason this advice usually carries.** "Never use `public`"
describes PostgreSQL 14 and earlier, where the schema was world-writable and
any role could plant an object that shadowed a function on someone's
`search_path`. PostgreSQL 15 revoked `CREATE` from `PUBLIC`, and on a 18
container an ordinary application role already cannot create there:

```text
public | pg_database_owner | {pg_database_owner=UC, =U, orders_app=U}
has_schema_privilege('orders_app','public','CREATE') → f
```

That hazard is closed, and repeating it as the reason would be teaching
something false.

**The reason that survives is cost asymmetry.** A shared database is the
ordinary end state — an application beside a queue, an analytics tool, or a
second service on one managed instance — and moving a live table between
schemas afterwards is a migration with downtime risk. Declaring the namespace
in the first migration costs a block and nothing else. Two smaller things come
with it: grants scope to the schema (`GRANT … IN SCHEMA orders`) instead of to
every table `public` may ever hold, and nothing depends on `search_path`
resolution order.

**What it does not do is remove the namespace from your queries.** Prisma 8
addresses by namespace coordinate always — there is no flat `db.orm.Order` on
Postgres — so this turns `db.orm.public.Order` into `db.orm.orders.Order`, a
more meaningful coordinate rather than one fewer.

`examples/order-infrastructure` is the worked case: one `namespace orders`
block holding all three models and the policy, `internal/test-infra`'s grants
scoped to it, and `schema-drift.spec.ts` asserting the tables landed there.

## Row-level security, on the `@btravstack/prisma/rls` subpath

Two halves, and in Prisma 8 **both are declared**.

### The policy is in the contract

`@@rls` opts a model in and a `policy_<operation>` block declares the rule;
the planner emits `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` like any
other migration operation. No hand-written DDL, and no `@@map` — the wire name
is hashed from the block's contents.

```prisma
namespace orders {
  model Order {
    id       Int    @id @default(autoincrement())
    tenantId String
    orderId  String

    @@unique([tenantId, orderId])
    @@rls
  }

  policy_all order_tenant_isolation {
    target    = Order
    using     = sql`"tenantId" = current_setting('app.tenant_id', true)`
    withCheck = sql`"tenantId" = current_setting('app.tenant_id', true)`
  }
}
```

The `policy_*` block lives **inside** the namespace it polices and names its
target unqualified; `target = orders.Order` from the top level fails emit with
`PSL_INVALID_EXTENSION_BLOCK_MEMBER`.

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

const orders = await tenantPinned(db, tenant, (tx) => tx.orm.orders.Order.all());
```

| Export                               | What it is                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `tenantPinned(db, tenant, work, o?)` | Runs `work` in a transaction pinned to `tenant`. Answers whatever `work` answers.                                               |
| `TenantPinnedOptions<S>`             | `{ setting?: string }` — the run-time setting the policy reads, default `app.tenant_id` — and `raises`, as `tryQuery` takes it. |

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
  deployment runs with **two URLs**: the **migration URL**, the owner's, which
  only `prisma db migrate` reads, before the process starts; and the **runtime
  URL** in `DATABASE_URL`, a role that is neither, with explicit grants.
  `prismaDatabase` refuses to boot on the first — a managed `postgres` user, or
  the migration role reused at runtime — with `RowSecurityBypassed`:

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
  superuser, nor exempt from row security, nor an owner of a policed table" as
  a standing test, beside `database.spec.ts`'s boot as the owner refused — a
  regression handing the owner's URL back is red on its own, without waiting
  for a policy test to notice.

- **The grants are yours.** Prisma 8 authors policies and not `GRANT`s; a role
  with policies and no grant gets a permission error rather than filtered rows.
  Without `GRANT USAGE, SELECT ON ALL SEQUENCES` in particular, an insert into a
  table with an `autoincrement()` column fails on the sequence, with an error
  that reads nothing like an RLS refusal — so the DDL gets debugged in the wrong
  place.

### What a policy does not cover, it is your specs that do

A policy is per table, and the example polices `Order` and `OutboxMessage` —
the relay pins each tenant it claims, as the repository pins its writes.
`Customer` is left out deliberately: the `customers` procedures are unmarked,
so a request under them forks the `anonymous` kind and has no principal to take
a tenant from. The caller names the tenant on the input, and the adapter
reaches it on an unpinned client with `where({ tenantId, customerId })`.

That table is therefore **filtered by hand**, and what guards it is
`examples/order-infrastructure/src/prisma-customer-repository.spec.ts`'s "does
not read another tenant's customer" — **a spec, not the database**. A
hand-filter bug there is caught by a test run, not refused by PostgreSQL, and
that is the difference the policy buys on the other two.

## List tenants without cross-tenant row access

`tenantListing(options)` on `@btravstack/prisma/rls` declares a narrow
capability for per-tenant scheduled work. It returns
`Result<TenantListing, TenantListingInvalid>`: a migration operation definition
and `list(db, after?): AsyncResult<readonly string[], SqlError>`. The function returns
distinct non-null IDs as text from one physical table; it accepts an optional
last-ID cursor and returns no payload columns. Each call reads current data.

<!-- doctest: isolate
declare const db: { readonly raw: { readonly sql: unknown }; readonly runtime: unknown };
-->

```ts
import { tenantListing } from "@btravstack/prisma/rls";
import { rawSql } from "@prisma/orm-postgres/migration";

const declaration = tenantListing({
  schema: "orders",
  table: "order",
  tenantColumn: "tenantId",
  name: "order_tenants",
  owner: "tenant_listing_owner",
  role: "orders_app",
});

const operation = declaration.map((listing) => rawSql(listing.migration));
const tenants = declaration.toAsync().flatMap((listing) => listing.list(db));
```

In a migration scaffold created by `prisma migration new`, include
`rawSql(listing.migration)` in its `operations` getter. Validate the declaration
once and handle `TenantListingInvalid`; `getOrThrow()` at the migration CLI
boundary can terminate emission for an invalid declaration. Self-emit the
migration as usual. Apply through `prisma db migrate`, whose transaction keeps
function creation and public-execution revocation atomic. This helper does not
run migrations at application startup.

| Option            | Meaning                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`, `table` | Physical names of one existing row-secured table.                                                                                                           |
| `tenantColumn`    | Physical tenant column; defaults to `tenantId`.                                                                                                             |
| `name`            | New paged function in `schema`; also names its SELECT policy.                                                                                               |
| `owner`           | Existing trusted function-owner role, without superuser or BYPASSRLS. It needs CREATE in the schema to accept ownership.                                    |
| `role`            | Existing application role granted execution, without superuser, BYPASSRLS, schema CREATE (including through roles it can assume), or membership in `owner`. |

Identifiers are quoted and must be valid UTF-8, non-empty, NUL-free, and at
most PostgreSQL's 63-byte identifier limit. Owner and caller must differ.
Invalid declarations name the offending option in `TenantListingInvalid`.

The migration adds an owner-only SELECT policy, grants the owner schema usage
and SELECT on the tenant column, creates the SQL function with
`search_path = pg_catalog, pg_temp` and `row_security = on`, revokes PUBLIC
execution, and grants execution to `role`. It grants **no application table
privilege**. Existing policies, including FORCE ROW LEVEL SECURITY, remain in
place. The owner must have no effective SELECT privilege on any non-tenant column,
including through PUBLIC or inherited roles. A table owner has payload
privileges and is therefore refused; use a dedicated NOLOGIN function owner.

Prechecks require the table and roles to exist and the function name to have no overloads and the policy name to be unused.
Applicable restrictive SELECT/ALL policies must exclude the function owner:
a permissive owner policy cannot override them, so installation refuses them
rather than silently producing an incomplete tenant list. Postchecks verify
the function's body, return column, owner, language, NULL-input execution, settings, policy and
execution grants. Broader default function grants fail that check and roll
back the migration; adjust those defaults before installing. An existing
object with the same name and a different definition is refused, never
replaced. Do not subsequently grant the caller the owner role or schema CREATE.

The migration precheck verifies the migrator can assume the function owner:
`pg_has_role` uses `SET` on PostgreSQL 16 and later, and `MEMBER` on earlier
versions, where membership itself permits SET ROLE. Provision that membership
for an ordinary migrator before deployment.

Each call returns at most 100 IDs in bytewise (`C`) order. Pass the last ID as
`after` to fetch the next page, and stop on an empty page. Process each page
before fetching the next; do not collect the entire discovery into an array.
Concurrent writes can change later pages; discovery is not a snapshot.

Use `list(db, after?)` in the application's adapter for its tenant-listing port. A
scheduled parent workflow calls an activity backed by that port, then starts a
child per ID. Each child's data work still uses its own tenant scope and
`tenantPinned`. A listing of one table discovers tenants with data in that
table, not every tenant registered anywhere in the application.

The security constraints follow PostgreSQL's
[definer-function guidance](https://www.postgresql.org/docs/current/sql-createfunction.html#SQL-CREATEFUNCTION-SECURITY)
and [row-security rules](https://www.postgresql.org/docs/current/ddl-rowsecurity.html).

## Not included, deliberately

**Running migrations.** A deployment runs `prisma db migrate` against the same database
_before the process starts_ — and, where row security is on, as its **owner**
rather than the role `DATABASE_URL` carries. An application that migrates itself
at boot races every other replica.

A deployment runs that command **plain**. `migration plan` diffs against the
`db` ref — a committed file naming the contract hash a _development_ database
is at — and `db migrate --advance-ref db` is the only apply-time command that
moves it. That belongs to whoever authors a migration, not to a release running
from a built artifact: advancing it in a deploy would have a release writing a
repository file. Leave it behind on the authoring side, though, and the next
plan re-includes the migration you already shipped — the example README carries
the worked sequence.

**A non-transactional migration step.** `prisma db migrate` runs a whole
migration inside one `BEGIN … COMMIT`, and the planner never emits
`CONCURRENTLY` — so `CREATE INDEX CONCURRENTLY` cannot be a step of it
(`25001`), and a planned `createIndex` on a populated table blocks writes for
the whole build. A step that runs outside the transaction is Prisma's runner to
add, upstream; this package runs no migration at all. Until it exists, build
the index out of band and let the migration find it:

1. `prisma migration plan` as usual. The package's `ops.json` holds the
   operation, `index.<table>.<name>`, with its `CREATE INDEX` statement — the
   **name** the planner chose is what the next steps must use.
2. As the owner, run that statement with `CONCURRENTLY` after `INDEX` and
   nothing else changed: same name, same columns, same uniqueness and method,
   since `db migrate` verifies the resulting schema against the contract once
   it has applied.
3. Check that the build finished:
   `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass('"orders"."<name>"')`.
   A concurrent build that failed or was cancelled leaves an `INVALID` index
   behind under that name; `DROP INDEX CONCURRENTLY` it and go back to step 2.
   This step is not optional: the operation's check matches the index **by
   name only** — `to_regclass(…) IS NOT NULL`, nothing reads `indisvalid` —
   so the migration would accept an invalid index, and the table would carry
   one the planner never queries.
4. `prisma db migrate`. The runner tests each operation's postcheck before its
   precheck, finds the index already present, records the operation as
   skipped, and applies the rest in its one transaction.

**Engine-level tracing.** There is no engine. Prisma 8 is a TypeScript runtime
and ships no instrumentation package, so the `Instrumentations` loader this
starter contributed under Prisma 7 is gone, and with it the `Logger` it needed
for one `debug` line. The statement middleware is the whole seam, and it
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
