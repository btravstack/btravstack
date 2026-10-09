---
title: Use request-scoped services
description: Give a service the lifetime of one request — a repository bound to the caller's tenant — built over the application's database client, released when the request ends, and replaced in a test without rewriting the root.
---

<!-- doctest: prelude
import { Provider, type ServiceOf } from "@btravstack/di";
import { OrderRepository } from "@btravstack/example-order-application";
import { overridden } from "@btravstack/testing";
import { P } from "unthrown";
import { userAuth } from "../../auth.js";
import { OrderApi } from "../../module.js";
-->

# Use request-scoped services

> **How-to.** Build a service per request instead of once per process. For
> the machinery underneath — forks, seeds, one module per scheme — see
> [Open a per-request scope](/how-to/open-a-per-request-scope).

Most services live as long as the process: the database client, the logger,
the cache. Some only make sense for one caller. A repository that may only see
the caller's tenant is the usual one — build it once per process and every
request shares one tenant; pass the tenant to every method and every call site
can pass the wrong one.

A **request-scoped service** is built when a request is accepted, from what
the application scope already holds, and released when the request ends.
Nothing about it is special: it is an ordinary provider in an ordinary
`Module`. What makes it request-scoped is **where the module is bound**.

## Step 1 — the services one request gets

From `examples/order-api/src/request-scope.ts`, cut down to one scheme:

```ts
import { Module, Provider } from "@btravstack/di";
import {
  FindOrder,
  OrderApplicationModule,
  Tenant,
} from "@btravstack/example-order-application";
import { OrderTenantPersistence } from "@btravstack/example-order-infrastructure";
import { defineHttp } from "@btravstack/orpc-server";

export const auth = defineHttp({ authenticators: { user: userAuth } });

export const UserServices = Module("UserServices")({
  // The caller this request was authenticated as. The runtime supplies it, so
  // the composition root owes nothing for it.
  needs: [auth.principals.user],
  // `OrderTenantPersistence` builds the repository over `Tenant` and over the
  // ONE `OrderDatabase` the application scope holds — read, never rebuilt.
  imports: [OrderTenantPersistence, OrderApplicationModule],
  provides: [
    Provider(Tenant)({
      inject: { principal: auth.principals.user },
      sync: ({ principal }) => principal.tenantId,
    }),
  ],
  exports: [Tenant, FindOrder],
});
```

`FindOrder` comes out already bound to the tenant, so a handler calling it
names no tenant at all — there is no argument to get wrong.

## Step 2 — say which requests get it

The module is bound to the **scheme** that authenticated the request. Declare
that once, as a second call on the same `auth`:

```ts
export const api = auth.units<{ user: typeof UserServices }>();
```

It is a second call because `UserServices` names `auth.principals.user`: one
call carrying both would make `auth` depend on itself (`TS7022`). It is a
type, not a value, so `auth.ts` and this module can import each other without
a load-order trap.

The composition root then binds the value:

<!-- doctest: skip — binds the one scheme this page declares; examples/order-api/src/module.ts binds four, and the gate compiles it in full -->

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  unit: { user: UserServices },
  imports: [OrdersSlice, OrderPersistenceModule, observability(), otel()],
  // What the request scope reads from the application scope is exported.
  exports: [Logger, Tracer, Meter, OrderDatabase],
});
```

The two declarations are checked against each other. A root whose router
serves `user` and binds nothing for it is refused —
`"UNBOUND UNIT KINDS — units<…>() declared them, so bind each on unit"` — and
so is a different module under `user`, or a misspelt kind. The services
`UserServices` needs from the application scope are checked where every other
need is, at `start`.

## Step 3 — read them in a handler

A controller lists what its handlers read beside `inject`, and each handler
finds it on `context.unit`:

```ts
import { contract } from "@btravstack/example-order-api-contract";

export const findOrder = api.OrpcController(
  contract,
  "orders.find",
)({
  unit: { find: FindOrder },
  sync: () => ({ errors, context }, input) =>
    context.unit.find
      .execute(input.id)
      .map((order) => ({ id: order.id, quantity: order.quantity }))
      .mapErrCases((matcher) =>
        matcher.with(P.tag("OrderNotFound"), (error) =>
          errors.NOT_FOUND({ message: error.message, data: { id: error.id } }),
        ),
      ),
});
```

`orders.find` requires `user`, so it sees what `UserServices` exports. A
public procedure would see nothing from it: `context.unit.find` on an unmarked
leaf is TypeScript's own `Property 'find' does not exist`.

## What the lifetime is — and is not

- **Built per request, from shared parts.** Two requests build two
  repositories over one database client and one connection pool.
- **Released with the request.** An `onStop` on a request-scoped provider runs
  when the response is done, still inside the request's trace.
- **Not a transaction.** The request scope opens no database transaction and
  commits nothing when it ends. Each repository method opens its own —
  `tenantPinned` pins the tenant inside one — so two calls in one request are
  two transactions. When two writes must commit together, the adapter spells
  that transaction, as `examples/order-infrastructure`'s `save` does with the
  order row and its outbox row; see
  [Talk to the database](/how-to/talk-to-the-database).

## Replace one in a test

The root stays a constant. `overridden` substitutes a provider **inside** the
request scope by naming the scheme it is bound to:

```ts
declare const repository: ServiceOf<OrderRepository>;

export const TestApi = overridden(OrderApi, [], {
  unit: { user: [Provider(OrderRepository)({ inject: {}, value: repository })] },
});
```

The substitution is checked at boot: a scheme the root does not bind, or a
port its module no longer provides, fails the boot naming it. The full rules
are in [@btravstack/testing](/reference/testing#inside-a-unit-module).

## The same idea on the workers

An AMQP handler gets **message-scoped** services and a Temporal activity
**activity-scoped** ones, bound the same way — `AmqpModule`'s
`unit: { message }`, `TemporalModule`'s `unit: { activity }` — with the
delivery or the activity input in the place the caller has here.

All three are what the kernel calls a **unit**: one request, one delivery, one
activity attempt. That is why the binding is called `unit` and why a handler
reads `context.unit` on every transport. Several schemes with a module each,
and what each is handed, are
[Open a per-request scope](/how-to/open-a-per-request-scope)'s.
