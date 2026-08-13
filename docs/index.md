---
layout: home
title: di — a module-based dependency-injection container for TypeScript
description: Ports as the vocabulary your application defines, providers bound at one edge, and modules with imports and exports. Every wiring mistake the types can catch is a compile error. Nothing throws.

hero:
  name: "di"
  text: "Wiring, checked at compile time"
  tagline: Ports as the vocabulary your application defines, providers bound at one edge, and modules that declare their imports and exports — with unmet dependencies, leaked internals and resource leaks caught by the compiler, and Result instead of throws.
  image:
    light: /logo-light.svg
    dark: /logo-dark.svg
    alt: di
  actions:
    - theme: brand
      text: Get Started
      link: /tutorial/getting-started
    - theme: alt
      text: Why di?
      link: /explanation/why-di
    - theme: alt
      text: GitHub
      link: https://github.com/btravstack/di

features:
  - icon: 🧭
    title: Ports name what you need
    details: "A port is the application's own word for a dependency — OrderRepository, never PostgresOrderRepository. Nominal by id, so two ports sharing a shape can never be swapped by accident. Application code depends on the port; adapters bind it at one edge."
  - icon: 🧱
    title: Wiring mistakes are compile errors
    details: "A missing dependency, an internal port leaking out of a module, a resourceful graph built without a scope — each is an error at the call site, not a runtime surprise. What the types cannot catch (a cycle, a duplicate provider) is a defect before any factory runs."
  - icon: 🔐
    title: Modules keep internals private
    details: "A module exports the ports outside code may see; everything else stays unnameable — even though the built container is one flat map at runtime. Swap a production adapter for an in-memory one without touching the application module."
  - icon: 🪢
    title: Resources release themselves
    details: "A provider with acquire/release routes its module through Module.scoped, which closes the scope on every path out — success, failure, or partial failure — releasing in reverse acquisition order. Nothing throws: every fallible operation returns an unthrown Result."
---

## At a glance

```ts
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { Err, Ok, type AsyncResult } from "unthrown";

// 1. Ports: named by the domain, never by whatever will implement them.
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

Swap `Persistence` for a resource-free in-memory module and `Module.build` (no
scope, no teardown) compiles too — but passing the _resourceful_ module to
`Module.build` does not: `Needs` still contains `Scope`, so the call is rejected
before anything runs.
