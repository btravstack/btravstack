---
title: Keep a port private
description: Use a module's exports list as the visibility boundary — internal ports stay unnameable outside the module, enforced at compile time, even though the built container is one flat map.
---

<!-- doctest: prelude
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { Env } from "@btravstack/config";
import { Err, Ok, TaggedError, type AsyncResult } from "unthrown";
type Order = { readonly id: string; readonly total: number };
class OrderNotFound extends TaggedError("OrderNotFound")<{ readonly id: string }> {}
type PoolClient = {
  readonly findById: (id: string) => Order | undefined;
  readonly close: () => void;
};
class AppConfig extends Port("AppConfig")<{ readonly url: string }> {}
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
declare const ConfigModule: Module<AppConfig, never, never>;
declare const openPool: (deps: {
  readonly config: ServiceOf<AppConfig>;
}) => AsyncResult<PoolClient, never>;

class Pool extends Port("Pool")<PoolClient> {}
class Metrics extends Port("Metrics")<{ readonly count: () => void }> {}
class Audit extends Port("Audit")<{ readonly record: () => void }> {}
class GetOrderInteractor {
  readonly #orders: ServiceOf<OrderRepository>;
  constructor({ orders }: { readonly orders: ServiceOf<OrderRepository> }) {
    this.#orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.#orders.findById(id);
  }
}
declare const Config: Module<AppConfig, never, Env>;
declare const makeRepository: (pool: ServiceOf<Pool>) => ServiceOf<OrderRepository>;
declare const makeAudit: (deps: { readonly pool: ServiceOf<Pool> }) => ServiceOf<Audit>;
declare const ctx: import("@btravstack/di").Context<GetOrder>;
declare const DatabaseModule: Module<Pool, never, Env>;
declare const CacheModule: Module<Metrics, never, Env>;
-->

# Keep a port private

> **How-to.** Hide a module's internals — a pool, a raw client, a parsed
> config — from everything outside it, with the compiler enforcing the line.
> For _why_ that is a withheld type rather than a runtime wall, see
> [Modules and privacy](/explanation/modules-and-privacy).

**Goal:** a module with internals nothing outside can reach, and a boundary
the compiler enforces rather than a naming convention.

## Export the surface, withhold the rest

Privacy in `di` is not a keyword; it is the `exports` list. Everything a
module provides but does not export is internal:

```ts
const Persistence = Module("Persistence")({
  imports: [Config],
  provides: [
    Provider(Pool)({
      inject: { config: AppConfig },
      acquire: openPool,
      release: (pool) => pool.close(),
    }),
    Provider(OrderRepository)({
      inject: { pool: Pool },
      sync: ({ pool }) => makeRepository(pool),
    }),
  ],
  exports: [OrderRepository], // Pool and AppConfig: not listed, not visible
});
```

Any module importing `Persistence` sees exactly one port:

```ts
// @ts-expect-error — UNDECLARED NEEDS: `Pool` is neither provided, imported, nor named in `needs`.
const App = Module("App")({
  imports: [Persistence],
  provides: [
    Provider(GetOrder)({
      inject: { orders: OrderRepository },
      class: GetOrderInteractor,
    }),
    Provider(Audit)({ inject: { pool: Pool }, sync: makeAudit }), // Pool is not visible here
  ],
  exports: [GetOrder],
});
```

The second provider does not wire: `Pool` is not among what `App` can see —
its own provides plus its imports' exports — so the dependency is unmet, and
`App` neither provides it nor names it in `needs`. That is refused **at this
module**, and the diagnostic names the port:

```text
Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
  '{ imports: [...]; provides: [...]; exports: [...]; }' but required in type
  '{ readonly "UNDECLARED NEEDS — name it in `needs`": Pool; }'.
```

Naming it in `needs` is not a way round the boundary — it does not make
`Persistence`'s `Pool` visible; it says _some composition root supplies a
`Pool`_, and one has to, or nothing can build `App`. The privacy holds either
way: what `Persistence` exports is still the only thing an importer can reach
through it.

And on a built context:

```ts
ctx.get(GetOrder); // compiles
// @ts-expect-error — the context's channel holds only App's exports
ctx.get(Pool); // does not compile
```

## What makes this work — and what it is not

The built container is a **single flat map at runtime**. `Pool`'s service is
genuinely in it — there is nowhere else to put it — so this is not runtime
sandboxing. What `exports` withholds is the _type_: the built `Context`'s
channel contains only the exported ports, so `ctx.get(Pool)` has no overload
that accepts it. The port class itself may be a plain TypeScript `export` (so
tests can name it); what matters is the DI module's `exports` list.

[Hexagonal (di alone)](/examples/di-hexagonal) pins exactly this with a
`@ts-expect-error` in its `index.test-d.ts` — the guarantee is compile-time
only, so the proof is a type-level test, not a runtime assertion.

## Exports are checked, not declarative

The `exports` list cannot lie:

```ts
Module("Persistence")({
  provides: [
    Provider(OrderRepository)({
      inject: { pool: Pool },
      sync: ({ pool }) => makeRepository(pool),
    }),
  ],
  // @ts-expect-error — NOT EXPORTABLE: `Metrics` is neither provided nor imported.
  exports: [OrderRepository, Metrics], // Metrics: neither provided nor imported
});
```

An export must be **available** — provided by this module, or exported by one
of its imports. Exporting something never imported, or re-exporting a
neighbour's internal, is a compile error at the declaration, not a silent
no-op.

## Re-export a whole module

Listing an imported module in `exports` re-exports its whole public surface —
useful for a facade module that groups plugins without re-listing every port:

```ts
const AppModule = Module("App")({
  imports: [DatabaseModule, CacheModule],
  exports: [DatabaseModule, CacheModule],
});
```

What stays private in `DatabaseModule` stays private here too: a whole-module
re-export forwards the module's `exports`, not its internals. The starters'
module sugar (`HttpModule`, `TemporalModule`, `AmqpModule`) keeps the same
discipline: each adds its runtime port to whatever `exports` you wrote, and
nothing of yours becomes visible that you did not list.

## See also

- [Modules](/reference/di/modules) — `imports`/`provides`/`exports`,
  precisely.
- [Modules and privacy](/explanation/modules-and-privacy) — the flat map, the
  withheld type, and why that is enough.
- [Swap an adapter for tests](/how-to/swap-an-adapter) — privacy is what
  makes the adapters interchangeable.
