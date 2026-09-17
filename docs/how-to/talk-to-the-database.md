---
title: Talk to a database
description: "Compose the Prisma starter, declare a repository port, write the adapter behind it, and run migrations where they belong — before the process starts."
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Module, Port, Provider } from "@btravstack/di";
import { prismaDatabase, type PrismaBinding } from "@btravstack/prisma";
import { tryQuery } from "@btravstack/prisma/result";
import { TaggedError, P, fromNullable, type AsyncResult } from "unthrown";

// The stand-in for the client YOUR contract types — there is no such type in
// the starter, which is the whole point of the `client` arrow.
type OrderRow = { readonly id: string; readonly quantity: number };
declare const postgres: (options: PrismaBinding & { readonly contractJson: unknown }) => {
  readonly raw: { readonly sql: unknown };
  readonly runtime: unknown;
  readonly orm: {
    readonly public: {
      readonly Order: { readonly first: (pk: { readonly id: string }) => Promise<OrderRow | null> };
    };
  };
};
declare const contractJson: unknown;
-->

# Talk to a database

> **How-to.** Get a working, pooled, correctly-closed database connection into
> an application, and reach it through a port your domain owns. For the
> starter's full surface, see [`@btravstack/prisma`](/reference/prisma).

## 1. Compose the starter

`prismaDatabase(name)({ client })` is a **module**: it binds `DATABASE_URL`
through `Config`, hands it to your client factory along with its own
middleware, and holds the result as a resourceful provider whose `release`
closes the pool on every exit path.

```ts
export const database = prismaDatabase("OrderDatabase")({
  client: ({ url, middleware }) => postgres({ contractJson, url, middleware }),
});
```

The `client` arrow is the one thing the starter cannot own: a Prisma 8 client
is typed by **your** emitted `Contract` and built from **your**
`contract.json`, so there is no client type to ship. Whatever you return is
what the port carries.

Spread `middleware` into the client rather than dropping it: that is the
starter's own `afterQuery` hook, and it is where the per-query observation
below comes from.

## 2. Declare the port your domain speaks

The port belongs to the application, not to the database. It names the thing
the domain needs, with the domain's own error on the channel:

```ts
class OrderNotFound extends TaggedError("OrderNotFound")<{ readonly id: string }> {}

export class OrderRepository extends Port("OrderRepository")<{
  readonly find: (
    id: string,
  ) => AsyncResult<{ readonly id: string; readonly quantity: number }, OrderNotFound>;
}> {}
```

Nothing in that names Prisma, which is what lets a test compose a different
adapter and what stops a schema change reaching the domain.

## 3. Write the adapter behind it

One provider, injecting the starter's port — `database.port`, typed by exactly
what your `client` arrow returned:

```ts
export const prismaOrderRepository = Provider(OrderRepository)({
  inject: { db: database.port },
  sync: ({ db }) => ({
    find: (id) =>
      // `tryQuery` takes a THUNK, so the query starts inside the Result rather
      // than before it, and turns the database's SQLSTATEs into tagged errors.
      tryQuery(() => db.orm.public.Order.first({ id }))
        .mapErrCases((matcher, defect) =>
          // None of them is a modeled outcome of "find an order", so they go
          // to the defect channel rather than arriving as an `OrderNotFound`
          // the caller would read as "no such order".
          matcher.with(
            P.tag("UniqueConstraintViolation"),
            P.tag("ForeignKeyViolation"),
            P.tag("NotAuthorized"),
            (cause) => defect(cause),
          ),
        )
        // A miss IS a modeled outcome, and this is where it becomes one.
        .flatMap((row) => fromNullable(row, () => new OrderNotFound({ id })).toAsync()),
  }),
});
```

The `flatMap` is where a `null` row becomes the domain's `OrderNotFound` — the
one translation an adapter owes, and the reason the port's error channel says
what it says.

## 4. Compose it into the root

```ts
export const PersistenceModule = Module("Persistence")({
  imports: [database],
  provides: [prismaOrderRepository],
  exports: [OrderRepository],
  needs: [Env],
});
```

`database` goes in `imports`; `OrderRepository` is what the rest of the
application sees. The client port itself stays private unless you export it —
nothing outside this module should hold a Prisma client.

The module needs `Env`, for `DATABASE_URL`, and nothing else — the kernel
provides it. The starter needed a `Logger` under Prisma 7, for one `debug` line
about engine tracing's optional peer; Prisma 8 has no engine and no such
package, so that need went with it.

## 5. Migrations run before the process, never at boot

```sh
npx prisma db migrate
```

That is a deployment step — a Job or a release command that runs to completion
**before** the rollout, never something the application does to itself at
startup. An application that migrates at boot races every other replica: three
pods, three migrations, one of them losing.

## 6. Scope it to the tenant

If the application is multi-tenant, a `tenantId` in every `where` the adapter
writes is a filter someone has to remember. Row-level security moves that
guarantee into PostgreSQL, and both halves are declared rather than written by
hand.

**The policy is in the contract**, so the planner emits it like any other
operation:

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

**The pin is a transaction**, from `@btravstack/prisma/rls`:

<!-- doctest: isolate
import { tenantPinned } from "@btravstack/prisma/rls";
import type { OrderDatabaseClient } from "@btravstack/example-order-infrastructure";

declare const db: OrderDatabaseClient;
declare const tenant: string;
-->

```ts
const orders = await tenantPinned(db, tenant, (tx) => tx.orm.public.Order.all());
```

`set_config(..., true)` is transaction-local, which is why this opens one
rather than handing back a pinned client: a session-scoped pin works only
while the pool happens to return the same connection, and fails silently the
first time it does not. Inside it the tenant **predicate** leaves that table's
reads and writes — `examples/order-infrastructure`'s `list` names no tenant at
all — and forgetting to name it stops being a way to read someone else's rows.
The **column** and the **key** stay: `save` still writes `tenantId`, and `find`
and `remove` still address `(tenantId, orderId)`.

**Two things are still yours**, and both fail quietly rather than loudly:
Prisma 8 authors policies but not `GRANT`s, and it emits `ENABLE ROW LEVEL
SECURITY` with no way to say `FORCE` — so the table's **owner bypasses every
policy**. Connect as a non-owner role. Both, with what each looks like when it
is missing, are on [the reference page](/reference/prisma); the worked
application is `examples/order-infrastructure`, with `src/rls.spec.ts` proving
it against a real server as a `NOSUPERUSER NOBYPASSRLS` role.

It is the **floor** under the three layers that decide who a caller is and what
they may do, not a replacement for any of them:
[Authorize a request](/how-to/authorize-a-request) is where they are stated.

## What you get for free

- **`DATABASE_URL` validated once**, as the graph builds: unset or blank is a
  `ConfigInvalid` naming the variable, which `runMain` prints and exits `78`
  for — not a crash on the first query.
- **The pool closed on every exit path**, including a boot that failed after it
  opened.
- **A health check** named after the starter, `SELECT 1` through the raw lane,
  folded into the kernel's `/healthz` with nothing wired.
- **Every query counted and its failures logged**, through the `Observers` set
  port — compose `observability()` and `otel()` beside it and the instruments
  appear; compose neither and it costs one inert call. The starter's middleware
  is what reports them, so it sees the ORM lane, the SQL builder and the raw
  lane alike, with the runtime's own `latencyMs`.

## Testing it

The starter has no in-memory adapter, and that is deliberate: an "in-memory
Prisma" for arbitrary SQL is not something anyone can write. Two honest
options:

- **Swap at the port you declared.** `OrderRepository` is your interface, so a
  test composes a `Map`-backed provider in its place — see
  [Swap an adapter for tests](/how-to/swap-an-adapter).
- **Run the real database.** A container per test suite, a **tenant** or a
  schema per test for isolation. That is what this repository's own examples do.

## Where to go next

- The starter's surface: [`@btravstack/prisma`](/reference/prisma).
- Cache what you read: [Cache a read](/how-to/cache-a-read).
- Make the pod stop cleanly, pool included:
  [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes).
