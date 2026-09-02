---
title: Talk to a database
description: "Compose the Prisma starter, declare a repository port, write the adapter behind it, and run migrations where they belong — before the process starts."
---

<!-- doctest: group=order-api -->
<!-- doctest: prelude
import { Env } from "@btravstack/config";
import { Logger } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { prismaDatabase } from "@btravstack/prisma";
import { PrismaPg } from "@prisma/adapter-pg";
import { ErrAsync, OkAsync, TaggedError, fromPromise, type AsyncResult } from "unthrown";

// The stand-in for the client YOUR schema generates — there is no such type in
// the starter, which is the whole point of the `client` arrow.
declare class PrismaClient {
  constructor(options: { readonly adapter: PrismaPg });
  $disconnect(): Promise<void>;
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  order: {
    findUnique(args: {
      where: { readonly id: string };
    }): Promise<{ readonly id: string; readonly quantity: number } | null>;
  };
}
-->

# Talk to a database

> **How-to.** Get a working, pooled, correctly-closed database connection into
> an application, and reach it through a port your domain owns. For the
> starter's full surface, see [`@btravstack/prisma`](/reference/prisma).

## 1. Compose the starter

`prismaDatabase(name)({ client })` is a **module**: it binds `DATABASE_URL`
through `Config`, builds the Postgres driver adapter from it, and holds your
client as a resourceful provider whose `release` closes the pool on every exit
path.

```ts
export const database = prismaDatabase("OrderDatabase")({
  client: (adapter) => new PrismaClient({ adapter }),
});
```

The `client` arrow is the one thing the starter cannot own: a Prisma client is
generated from **your** schema, so there is no client type to ship. Whatever
you return is what the port carries — apply
[`@unthrown/prisma`](https://github.com/btravstack/unthrown)'s extension here
too, if you want the `try*` twins, and the graph holds the extended client
rather than a bare one.

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
      fromPromise(
        db.order.findUnique({ where: { id } }),
        // The boundary's qualify: a driver failure is nobody's modeled
        // outcome, so it becomes a defect rather than an `OrderNotFound`
        // the caller would handle as "no such order".
        (cause, defect) => defect(cause),
      ).flatMap((row) =>
        row === null
          ? // A miss IS a modeled outcome, and this is where it becomes one.
            ErrAsync(new OrderNotFound({ id }))
          : OkAsync({ id: row.id, quantity: row.quantity }),
      ),
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
  needs: [Env, Logger],
});
```

`database` goes in `imports`; `OrderRepository` is what the rest of the
application sees. The client port itself stays private unless you export it —
nothing outside this module should hold a Prisma client.

The module needs `Env` (for `DATABASE_URL`) and `Logger` (for the one `debug`
line the starter writes when engine tracing's optional peer is absent). Both
are satisfied at the composition root, and the kernel provides `Env` itself.

## 5. Migrations run before the process, never at boot

```sh
npx prisma migrate deploy
```

That is a deployment step — a Job or a release command that runs to completion
**before** the rollout, never something the application does to itself at
startup. An application that migrates at boot races every other replica: three
pods, three migrations, one of them losing.

## What you get for free

- **`DATABASE_URL` validated once**, as the graph builds: unset or blank is a
  `ConfigInvalid` naming the variable, which `runMain` prints and exits `78`
  for — not a crash on the first query.
- **The pool closed on every exit path**, including a boot that failed after it
  opened.
- **A health check** named after the starter, `SELECT 1` through `$queryRaw`,
  folded into the kernel's `/healthz` with nothing wired.
- **Every query counted and its failures logged**, through the `Observers` set
  port — compose `observability()` and `otel()` beside it and the instruments
  appear; compose neither and it costs one inert call.
- **Engine-level tracing** when `@prisma/instrumentation` is installed, turned
  on by an OTel SDK being composed rather than by anything you write.

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
