# @btravstack/prisma

> The Prisma starter for [`@btravstack/core`](https://github.com/btravstack/btravstack):
> `DATABASE_URL` bound through `Config`, per-query observation as middleware,
> and a client whose pool is the application scope's. Prisma **8**.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/prisma)** ·
[API Reference](https://btravstack.github.io/btravstack/api/prisma/)

```sh
pnpm add @btravstack/prisma @btravstack/core @btravstack/config @btravstack/di unthrown \
  @prisma/orm-postgres@8.0.0-rc.11
```

Five peer dependencies — install every one, so the application holds a single
copy of each. The `prisma` CLI is yours, as a dev dependency: the client is
built from _your_ emitted contract, so there is none for this package to ship.
Node `>=22`.

**This is Prisma 8**, which is a different package family rather than a version
bump — `@prisma/orm-postgres` replaces `@prisma/client` and `@prisma/adapter-pg`
both, and there is no `@prisma/instrumentation`. For Prisma 7 use
`@btravstack/prisma@0.14`.

## A worked example

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Module } from "@btravstack/di";
import type { PrismaBinding } from "@btravstack/prisma";

// The stand-in for the client YOUR contract types. It does not exist in this
// package — that is what the `client` arrow is for.
declare const postgres: (options: PrismaBinding & { readonly contractJson: unknown }) => {
  readonly raw: { readonly sql: unknown };
  readonly runtime: unknown;
};
declare const contractJson: unknown;
-->

```ts
import { prismaDatabase } from "@btravstack/prisma";

const database = prismaDatabase("OrderDatabase")({
  client: ({ url, middleware }) => postgres({ contractJson, url, middleware }),
});
```

That is the whole surface. `database` is a **module** carrying the port a
composition root reads; the provider binding `DATABASE_URL`, the resourceful
client provider and the health check are inside it:

```ts
export const PersistenceModule = Module("Persistence")({
  imports: [database],
  exports: [database.port],
  needs: [Env],
});
```

**The client type is yours, and that is deliberate.** A Prisma 8 client is
typed by _your_ emitted `Contract` and built from _your_ `contract.json`, so
there is none for this package to ship — the `client` arrow is where your
contract and this starter meet, and the port is typed by exactly what it
returns. Spread the `middleware` it hands you into the client: that is where
the per-query observation below comes from.

## What it owns

- **`DATABASE_URL` through `Config`.** A missing or blank value is a modeled
  `ConfigInvalid` naming the variable, not a throw — so a misconfigured
  deployment exits `78` with the reason on stderr instead of crashing on the
  first query.
- **The pool's lifetime.** The provider is _resourceful_, so `release` closes it
  on every exit path, including a boot that fails after it ran.
- **A health check**, named after the starter — `SELECT 1` through the raw
  lane, folded into the kernel's `GET /healthz` with nothing wired. `/readyz`
  does not read it: failing readiness on a dependency every replica shares
  removes them all at once.
- **Every query handed to `Observers`**, as one `afterQuery` middleware, so
  composing `observability()` writes the failures as lines and `otel()` opens
  the spans and mints the instruments — with no flag here and no port list to
  satisfy when you compose neither. A middleware sees the ORM lane, the SQL
  builder and the raw lane alike, and carries the runtime's own `latencyMs`.

## `Result`s, on the `@btravstack/prisma/result` subpath

Prisma 8 throws a **structured** error carrying PostgreSQL's own SQLSTATE.
`tryQuery` turns that into a `Result` with three modeled arms —
`UniqueConstraintViolation` (`23505`, with the `constraint` the database
named), `ForeignKeyViolation` (`23503`) and `NotAuthorized` (`42501`,
including a write a row-security policy refused). Anything else is a defect.

<!-- doctest: isolate
import { tryQuery } from "@btravstack/prisma/result";
import { P } from "unthrown";

declare const db: { readonly orm: { readonly public: { readonly Order: { readonly create: (row: { readonly orderId: string }) => Promise<unknown> } } } };
declare const orderId: string;
declare const duplicate: (id: string) => Error;
-->

```ts
const saved = tryQuery(() => db.orm.public.Order.create({ orderId })).mapErrCases(
  (matcher, defect) =>
    matcher
      .with(P.tag("UniqueConstraintViolation"), () => duplicate(orderId))
      .with(P.tag("ForeignKeyViolation"), P.tag("NotAuthorized"), (cause) => defect(cause)),
);
```

It takes a **thunk** rather than a promise: an `AsyncResult` is eager, so a
promise built at the call site has already started before the Result exists.

## Row-level security, on the `@btravstack/prisma/rls` subpath

**The policy is declared in your contract** — `@@rls` on the model and a
`policy_all` block beside it — and the planner emits `ENABLE ROW LEVEL
SECURITY` and `CREATE POLICY` like any other migration operation. **The pin is
a transaction:**

<!-- doctest: isolate
import { tenantPinned } from "@btravstack/prisma/rls";

declare const db: {
  readonly raw: { readonly sql: unknown };
  readonly transaction: <R>(fn: (tx: { readonly query: (plan: never) => Promise<unknown>; readonly orm: { readonly public: { readonly Order: { readonly all: () => Promise<readonly unknown[]> } } } }) => PromiseLike<R>) => Promise<R>;
};
declare const tenant: string;
-->

```ts
const orders = await tenantPinned(db, tenant, (tx) => tx.orm.public.Order.all());
```

`set_config(…, true)` is **transaction-local**, which is why this opens one
rather than handing back a pinned client: a session-scoped pin works only while
the pool happens to return the same connection, and fails silently the first
time it does not. The policy must read the **same** setting — `app.tenant_id`
is only the default — because a `tenantPinned(db, tenant, work, { setting })`
and a policy naming a different one deny every row and every write, which looks
exactly like row security working.

Two halves stay the deployment's, and both fail quietly when forgotten: Prisma 8
authors policies but no `GRANT`s, and it emits `ENABLE ROW LEVEL SECURITY` with
no way to say `FORCE` — so the table's **owner**, which is the role that ran the
migrations, bypasses every policy. Connect as a role that is neither the owner
nor a superuser. The
[reference page](https://btravstack.github.io/btravstack/reference/prisma)
carries the DDL and the smaller lines that fail the same way.

## What it does not

**Migrations.** A deployment runs `prisma db migrate` against the same database
_before the process starts_ — and, where row security is on, as its **owner**
rather than the role `DATABASE_URL` carries. An application that migrates itself
at boot races every other replica.

**Engine-level tracing.** There is no engine: Prisma 8 is a TypeScript runtime
and ships no instrumentation package, so the `afterQuery` middleware is the
whole seam and it already carries the runtime's own latency.

**Transactions.** Commit boundaries belong to the adapter, spelled at the call —
`db.transaction(fn)` is the primitive. The `rls` subpath opens one transaction
to pin a setting on and the work inside it is yours. There is no unit-scoped
transaction and there will not be one; see
[the kernel maps nothing](https://btravstack.github.io/btravstack/explanation/the-kernel-maps-nothing).

**A repository base class.** Ports are your application's vocabulary, not this
package's.

## Options

| Option         | Where                                         | What it is                                                                               |
| -------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `name`         | `prismaDatabase(name)`                        | the port's id and the health check's name — required                                     |
| `client`       | `prismaDatabase(name)({ client })`            | builds your client from the URL and middleware this package bound — required             |
| `DATABASE_URL` | environment, read by `prismaDatabase(name)`   | the connection string — required, validated at graph build; blank is an error, exit `78` |
| `setting`      | `tenantPinned(db, tenant, work, { setting })` | the PostgreSQL run-time setting the policy reads — default `app.tenant_id`               |

There is **no `instrumented` flag**: observation is a set port every call is
handed to, so a graph composing no observability pays one inert call and no
port list. The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/prisma),
which is this list's one detailed home.

## License

MIT
