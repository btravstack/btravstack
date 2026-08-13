---
title: Getting started
description: Build a working dependency graph from nothing — declare ports, bind providers, compose modules, build the container, then add a real resource and watch the compiler route you to the right entry point.
---

# Getting started

By the end of this page you will have declared two ports, written a use case
that depends on one of them without knowing its implementation, wired both into
a module, built the container, and then added a real resource — at which point
the compiler itself will tell you the entry point you were using is no longer
the right one.

The snippets build on one another, so follow along in a `.ts` file. The lines
marked `// ✗` are meant not to compile, and that is the point of them.

## Install

```sh
pnpm add @btravstack/di unthrown
```

Both, because `unthrown` is a **peer** dependency — the package hands you back
_your_ copy of it rather than its own.
([Why](/explanation/peer-dependencies).) Every fallible operation in `di`
returns an unthrown `Result`; nothing throws.

## 1. Declare your ports

A port is the application's own name for something it needs — named by the
domain, never by whatever will eventually implement it:

```ts
import { Port } from "@btravstack/di";
import { Err, Ok, TaggedError, type AsyncResult } from "unthrown";

class OrderNotFound extends TaggedError("OrderNotFound")<{
  readonly id: string;
}> {}

type Order = {
  readonly id: string;
  readonly total: number;
};

class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

`Port(id)<Shape>` is a nominal token: two ports declared with the same `Shape`
but different ids are different types, so a `Database` and a `Cache` that
happen to share a service shape can never be swapped for each other by
accident. The class itself is a phantom — it is never instantiated; it exists
so the type system can tell ports apart and the runtime can key services by
`id`.

## 2. Write the use case against the port

`ServiceOf<P>` recovers the shape a service must have to satisfy a port — used
here to type the interactor's dependency without ever importing an adapter:

```ts
import { type ServiceOf } from "@btravstack/di";

class GetOrderInteractor {
  private readonly orders: ServiceOf<OrderRepository>;
  constructor(orders: ServiceOf<OrderRepository>) {
    this.orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.orders.findById(id);
  }
}
```

Nothing in this class knows whether the eventual implementation talks to
Postgres or is an in-memory fake. That decision belongs to the composition
root, and it has not been made yet.

## 3. Bind providers, group them in a module

A `Provider` binds a port to a concrete construction. A `Module` groups
providers and declares what outside code may see:

```ts
import { Module, Provider } from "@btravstack/di";

const InMemoryPersistence = Module("InMemoryPersistence")({
  provides: [
    Provider(OrderRepository)({
      value: { findById: (id) => Ok({ id, total: 99 }).toAsync() },
    }),
  ],
  exports: [OrderRepository],
});

const App = Module("App")({
  imports: [InMemoryPersistence],
  provides: [
    Provider(GetOrder)([OrderRepository], { class: GetOrderInteractor }),
  ],
  exports: [GetOrder],
});
```

Two arms of the [construction family](/reference/providers) appear here:
`value` (the service is already at hand) and `class` (construct this class,
passing the resolved dependencies — the `[OrderRepository]` array —
positionally to its constructor). The dependency array is what ties
`GetOrderInteractor`'s constructor parameter to the port that will satisfy it,
and its element types are checked against the constructor's parameters.

## 4. Build it, use it

```ts
const result = await Module.build(App).flatMap((ctx) =>
  ctx.get(GetOrder).execute("o-1"),
);
```

`Module.build` checks the graph, constructs every provider in dependency
order, and resolves to a `Context` — the built container. `ctx.get(GetOrder)`
returns the constructed service, typed exactly as the port declared.

Two things worth noticing before moving on:

- `ctx.get(OrderRepository)` does **not** compile. Only `GetOrder` is in
  `App`'s `exports`, so that is the only port the built `Context` lets you
  name. The repository's service is genuinely in the container at runtime; the
  _type_ that would let you reach it is withheld.
  ([How that works](/explanation/modules-and-privacy).)
- `result` is a `Result`, not a bare value. Handle it as one:

```ts
import { P } from "unthrown";

const outcome = result.match({
  ok: (order) => `total: ${order.total}`,
  errCases: (m) =>
    m.with(P.tag("OrderNotFound"), (e) => `no such order: ${e.id}`),
  defect: (cause) => {
    console.error(cause);
    return "bug";
  },
});
```

The `defect` branch is not decoration: a wiring bug — a dependency cycle, two
providers for one port — lands there, kept apart from the failures your code
models. ([Failures vs defects](/explanation/failures-vs-defects).)

## 5. Let construction fail as a value

`value` cannot fail. Real construction often can — a config read, a validated
client. The `make` arm returns a `Result`, and its error channel joins the
module's own:

```ts
class Env extends Port("Env")<Record<string, string | undefined>> {}
class AppConfig extends Port("AppConfig")<{ readonly dbUrl: string }> {}
class ConfigError extends TaggedError("ConfigError")<{
  readonly reason: string;
}> {}

const Config = Module("Config")({
  provides: [
    Provider(Env)({ value: process.env }),
    Provider(AppConfig)([Env], {
      make: (env) =>
        env["DATABASE_URL"] === undefined
          ? Err(new ConfigError({ reason: "DATABASE_URL is unset" }))
          : Ok({ dbUrl: env["DATABASE_URL"] }),
    }),
  ],
  exports: [AppConfig],
});
```

A failing `make` stops construction, and the `ConfigError` comes back through
the same `Result` you already handle — now one of the `errCases`.

## 6. Add a real resource

A connection pool is not a value: it must be acquired, and it must be released.
That is the `acquire`/`release` arm:

```ts
class Database extends Port("Database")<{
  readonly query: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

const Persistence = Module("Persistence")({
  imports: [Config],
  provides: [
    Provider(Database)([AppConfig], {
      acquire: (config) => openPool(config.dbUrl),
      release: (pool) => pool.close(),
    }),
    Provider(OrderRepository)([Database], {
      sync: (db) => ({ findById: (id) => db.query(id) }),
    }),
  ],
  exports: [OrderRepository], // Database stays internal to this module.
});

const ProdApp = Module("App")({
  imports: [Persistence],
  provides: [
    Provider(GetOrder)([OrderRepository], { class: GetOrderInteractor }),
  ],
  exports: [GetOrder],
});
```

## 7. Watch the compiler change your entry point

```ts
await Module.build(ProdApp); // ✗ does not compile — "UNSATISFIED DEPENDENCIES"
```

Choosing the resourceful arm put a phantom requirement — `Scope` — into the
provider's `Needs`, and it propagated through `Persistence` into `ProdApp`.
`Module.build` demands a module with no unmet needs, opens no scope and runs no
teardown, so it refuses the graph _at the call site_. Forgetting to release the
pool is not a runtime leak here; it is a type error.

The entry point that discharges `Scope` is `Module.scoped`:

```ts
const result = await Module.scoped(ProdApp, (ctx) =>
  ctx.get(GetOrder).execute("o-1"),
);
```

It opens a scope, builds the graph, hands the `Context` to your callback, and
closes the scope — releasing every acquired resource in reverse acquisition
order — before its own result resolves. On success, on failure, and on a
mid-graph partial failure alike.
([What the scope guarantees](/explanation/scopes-and-resources).)

## 8. Swap the adapter, keep the application

The application module never named an adapter, so wiring it the other way is a
one-line change at the composition root — and `Module.build` accepts the
in-memory graph, because nothing in it needs a scope:

```ts
const built = await Module.build(App); // ✓ the in-memory graph from step 3
```

One application, two adapters, and the type system — not a convention — decides
which entry point each graph is allowed to use.
([The worked version](/how-to/swap-an-adapter).)

## Where to go next

- [Swap an adapter for tests](/how-to/swap-an-adapter) — the seam above, made a
  pattern.
- [Manage a resource's lifetime](/how-to/manage-a-resource) — `acquire`,
  `release`, and the `onStart`/`onStop` hooks.
- [Open a per-request scope](/how-to/request-scope) — a transaction per request
  with `Module.forkScope`.
- [Build a plugin registry](/how-to/plugin-registry) — many providers, one set
  port, with `Port.many`.
- [Reference](/reference/ports) — every member, arm and entry point.
- [Why di?](/explanation/why-di) — the design, and what it refuses to do.
