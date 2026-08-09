# @btravstack/di

A dependency-injection container built around three ideas:

- **Ports** are the vocabulary an application defines for what it needs — never what
  an adapter happens to provide.
- **Providers** bind a port to a concrete construction — a value, a factory, a class,
  or a resource with its own teardown.
- **Modules** group providers, declare what they need from elsewhere (`imports`), and
  declare what they let outside modules see (`exports`) — everything else stays
  private, even though the built container is a single flat map at runtime.

Every wiring mistake this package can catch — a missing dependency, an internal port
leaking out of a module, a re-export of something never imported — is a compile
error, not a runtime surprise. What it cannot catch at compile time (a cycle, two
providers registered for the same port) is caught before any factory runs, as a
defect, not silently.

This README is a worked example: a small hexagonal slice — one use case, one port for
its repository, a resourceful production adapter and a resource-free in-memory one —
built the same way an application depending on this package eventually will. The full
version, exercised end to end, lives in `src/example.spec.ts` / `src/example.test-d.ts`.

## Ports: the application's boundary

A port is declared once, named by the domain — not by whatever will eventually
implement it:

```ts
import { Port, type ServiceOf } from "@btravstack/di";
import type { AsyncResult } from "unthrown";

interface Order {
  readonly id: string;
  readonly total: number;
}

class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

`Port(id)<Shape>` is a nominal token: two ports declared with the same `Shape` but
different `id`s are different types, so a `Database` and a `Cache` that happen to
share a service shape can never be swapped for each other by accident. `ServiceOf<P>`
recovers the shape a service must have to satisfy `P` — used below to type an
application class's own dependency, without that class ever importing an adapter.

## Application: depending on the port, never the adapter

```ts
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

`GetOrderInteractor` only ever sees `OrderRepository`'s port shape. Nothing here
knows whether the eventual implementation talks to Postgres or is an in-memory
fake — that is the adapter's problem, decided at the composition root, below.

## Adapters: bound at one edge

A `Provider` binds a port to a construction. Two adapters implement
`OrderRepository` here — a production one backed by a resourceful `Database` port,
and an in-memory one with nothing to release:

```ts
import { Module, Provider } from "@btravstack/di";
import { Err, Ok } from "unthrown";

const ConfigModule = Module("Config")({
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

const makePersistenceModule = () =>
  Module("Persistence")({
    imports: [ConfigModule],
    provides: [
      // A real connection: acquired once, released on teardown. This is the
      // resourceful arm, and it is what puts `Scope` in this module's `Needs`.
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

const InMemoryPersistenceModule = Module("InMemoryPersistence")({
  provides: [
    Provider(OrderRepository)({
      value: { findById: (id) => Ok({ id, total: 99 }).toAsync() },
    }),
  ],
  exports: [OrderRepository],
});
```

`Database` never appears in either module's `exports`, so nothing outside
`Persistence` can name it — `OrderRepository` is the only port either adapter module
makes visible. That privacy is enforced at the type level: the built container is a
single flat map at runtime (there is nowhere else to put a service), so an internal
port really is present in it, but `exports` withholds the _type_ that would let a
caller call `ctx.get(Database)` in the first place. `src/example.test-d.ts` pins
exactly this with a `@ts-expect-error`.

## Composition root: one application module, either adapter

The application module is generic in the persistence module's own error and
requirement channels, so it wires up unchanged against either adapter:

```ts
const makeAppModule = <E, N>(persistence: Module<OrderRepository, E, N>) =>
  Module("App")({
    imports: [persistence],
    provides: [
      Provider(GetOrder)([OrderRepository], { class: GetOrderInteractor }),
    ],
    exports: [GetOrder],
  });
```

What differs is the entry point used to build it — and the type system, not a
convention, is what forces the right one:

```ts
// The production graph needs Scope (Database is resourceful), so it must go
// through Module.scoped, which opens a scope and guarantees it is closed —
// on success, on failure, or on a mid-graph partial failure — before this
// call resolves.
const result = await Module.scoped(
  makeAppModule(makePersistenceModule()),
  (ctx) => ctx.get(GetOrder).execute("o-1"),
);

// The in-memory graph has nothing resourceful, so its Needs is `never` —
// Module.build accepts it directly. Passing it to Module.scoped instead
// would also work (Scope is simply absent from Needs); passing the
// production module to Module.build is the one that does not compile.
const built = await Module.build(makeAppModule(InMemoryPersistenceModule));
```

Trying to build the resourceful graph with `Module.build` is a compile error, not
a runtime leak: `Needs` still contains `Scope`, so the call's arity gate — the
"UNSATISFIED DEPENDENCIES" rest parameter every unmet requirement produces — rejects
it before anything runs. `Module.scoped` is the one entry point that opens a scope
and discharges `Scope` from `Needs`.

## The construction family

Every `Provider` picks exactly one of five mutually exclusive arms — supplying more
than one key at once is a compile error, not merely redundant:

| Arm                   | Shape                                                                                              | When                                                                                | Puts `Scope` in `Needs`? |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------ |
| `value`               | `S`                                                                                                | The service is already at hand — a config object, a constant.                       | No                       |
| `sync`                | `(...deps) => S`                                                                                   | Built synchronously from its dependencies, and cannot fail.                         | No                       |
| `make`                | `(...deps) => Result<S, E> \| AsyncResult<S, E>`                                                   | Built fallibly, possibly asynchronously — a parsed config, a validated client.      | No                       |
| `class`               | `new (...deps) => S`                                                                               | Built by constructing a class, dependencies passed positionally to the constructor. | No                       |
| `acquire` + `release` | `acquire: (...deps) => Result<S, E> \| AsyncResult<S, E>`, `release: (s) => void \| Promise<void>` | A real resource — a connection, a file handle — that must be torn down.             | Yes                      |

Every arm also accepts optional `onStart` / `onStop` hooks (`(service) => void |
Promise<void>`), fired once the whole graph has finished constructing (`onStart`) or
during teardown (`onStop`) — supplied inline in the same options literal, e.g.
`Provider(Cache)({ value: cache, onStart: (c) => c.warm() })`. `onStop` puts `Scope`
in `Needs` for the same reason `acquire`/`release` does: it is teardown, and only
`Module.scoped` (or `Module.forkScope`) ever opens a scope to run it.

`Port.many(id)<Member>` and `Provider.member(port)(...)` are the multi-binding
counterparts — several providers may target one set port (a plugin registry, a list
of health checks), and `Context.get` on it returns every contribution, accumulated
across module boundaries. `Module.forkScope` layers a short-lived scope over an
already-built parent `Context`, for per-request services that must not outlive the
request but may read what the parent already constructed. See `src/many.spec.ts` and
`src/fork.spec.ts` for both, worked end to end.

## Install

```sh
pnpm add @btravstack/di unthrown
```

`unthrown` is a **peer dependency** — install both.

## Public surface

```ts
export { Port } from "./port.js";
export type {
  AnyPort,
  ManyPortClass,
  PortClass,
  Scope,
  ServiceOf,
} from "./port.js";
export { Context } from "./context.js";
export { Provider } from "./provider.js";
export { Module } from "./module.js";
export type { ScopedOptions } from "./build.js";
```

`Scope` is a **type** only. Every legitimate use of it is a type position, and
the class value is what would let you write `Provider(Scope)(…)` or widen it to
`AnyPort` — the two ways past the guard. `PortClass` and `ManyPortClass` are
exported so that a consumer compiling with `declaration: true` can export a port
of its own; without them the emitter reaches the module-private brand symbols
and fails with TS4020. The symbols stay unexported, so port instances remain
unforgeable.

Everything else — `unsafeAdd`, `flatten`, `plan`, `run`, `runScoped`, `createScope`,
`constructLevel`, `WiringDefect`, and the handful of type-level helpers
(`ServicesOf`, `NeedsOf`, `PortInstance`, `Hooks`, …) that exist to make the four
files above typecheck — is implementation detail, not exported.
