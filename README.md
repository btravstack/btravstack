<div align="center">

# di

**A module-based dependency-injection container for [TypeScript](https://www.typescriptlang.org/) — ports as the vocabulary your application defines, providers bound at one edge, and `Result` instead of throws.**

[![CI](https://github.com/btravstack/di/actions/workflows/ci.yml/badge.svg)](https://github.com/btravstack/di/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40btravstack%2Fdi.svg?logo=npm)](https://www.npmjs.com/package/@btravstack/di)
[![npm downloads](https://img.shields.io/npm/dm/%40btravstack%2Fdi.svg)](https://www.npmjs.com/package/@btravstack/di)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

Ports are the vocabulary an application defines for what it needs — never what an
adapter happens to provide. Providers bind a port to a concrete construction: a
value, a factory, a class, or a resource with its own teardown. Modules group
providers and declare what they need from elsewhere (`imports`) and what they let
outside modules see (`exports`) — everything else stays private, even though the
built container is a single flat map at runtime. Every wiring mistake this package
can catch — a missing dependency, an internal port leaking out of a module, a
re-export of something never imported — is a compile error, not a runtime surprise.
What it cannot catch at compile time (a cycle, two providers registered for the same
port) is caught before any factory runs, as a defect, not silently. Nothing throws:
every fallible operation returns an
[`unthrown`](https://github.com/btravstack/unthrown) `Result`.

## Install

```sh
pnpm add @btravstack/di unthrown
```

`unthrown` is a **peer dependency** — install both.

## A worked example

```ts
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { Err, Ok, type AsyncResult } from "unthrown";

// 1. Ports: named by the domain, never by whatever will eventually implement them.
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

// 2. Application: depends on the port, never on an adapter.
class GetOrderInteractor {
  private readonly orders: ServiceOf<OrderRepository>;
  constructor(orders: ServiceOf<OrderRepository>) {
    this.orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.orders.findById(id);
  }
}

// 3. Adapter: bound at one edge. A resourceful one puts `Scope` in `Needs`.
const Persistence = Module("Persistence")({
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

// 4. Composition root: `Scope` in `Needs` forces `Module.scoped`, which opens
//    a scope and guarantees it is closed — success, failure, or partial
//    failure — before this call resolves.
const App = Module("App")({
  imports: [Persistence],
  provides: [
    Provider(GetOrder)([OrderRepository], { class: GetOrderInteractor }),
  ],
  exports: [GetOrder],
});

const result = await Module.scoped(App, (ctx) =>
  ctx.get(GetOrder).execute("o-1"),
);
```

Every wiring mistake this package can catch is a compile error. Swap `Persistence`
for a resource-free in-memory module and `Module.build` (no scope, no teardown)
compiles too — but passing the _resourceful_ module to `Module.build` does not:
`Needs` still contains `Scope`, so the call is rejected before anything runs.

## Documentation

See [`packages/di`](./packages/di) for the full package README — the construction
family (`value` / `sync` / `make` / `class` / `acquire`+`release`), set ports
(`Port.many` / `Provider.member`), and `Module.forkScope` for per-request scopes.

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution gate, the commit
convention, and how the Node version matrix is chosen.

## License

[MIT](./LICENSE) © Benoit TRAVERS
