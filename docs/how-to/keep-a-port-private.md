---
title: Keep a port private
description: Use a module's exports list as the visibility boundary — internal ports stay unnameable outside the module, enforced at compile time, even though the built container is one flat map.
---

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
    Provider(Pool)(
      { config: AppConfig },
      {
        acquire: openPool,
        release: (pool) => pool.close(),
      },
    ),
    Provider(OrderRepository)(
      { pool: Pool },
      {
        sync: ({ pool }) => makeRepository(pool),
      },
    ),
  ],
  exports: [OrderRepository], // Pool and AppConfig: not listed, not visible
});
```

Any module importing `Persistence` sees exactly one port:

```ts
const App = Module("App")({
  imports: [Persistence],
  provides: [
    Provider(GetOrder)(
      { orders: OrderRepository },
      { class: GetOrderInteractor },
    ),
    Provider(Audit)({ pool: Pool }, { sync: makeAudit }), // Pool is not visible here
  ],
  exports: [GetOrder],
});
```

The second provider does not wire: `Pool` is not among what `App` can see —
its own provides plus its imports' exports — so the dependency stays unmet,
and surfaces as `UNSATISFIED DEPENDENCIES` at the entry point — the arity
error, `Expected 3 arguments, but got 1`. Under
[`start`](/reference/core/start) the same mistake is caught differently: the
kernel's `module` parameter is `Module<X, E, Scope | Env>`, so the leftover
need fails to assign and the diagnostic **names the port** — measured on the
starters' own gates, where the last line is
`Type '"HttpRouter"' is not assignable to type '"@di/Scope"'`.

And on a built context:

```ts
ctx.get(GetOrder); // compiles
ctx.get(Pool); // does not compile
```

## What makes this work — and what it is not

The built container is a **single flat map at runtime**. `Pool`'s service is
genuinely in it — there is nowhere else to put it — so this is not runtime
sandboxing. What `exports` withholds is the _type_: the built `Context`'s
channel contains only the exported ports, so `ctx.get(Pool)` has no overload
that accepts it. The port class itself may be a plain TypeScript `export` (so
tests can name it); what matters is the DI module's `exports` list.

[Hexagonal order API](/examples/hexagonal-order-api) pins exactly this with a
`@ts-expect-error` in its `index.test-d.ts` — the guarantee is compile-time
only, so the proof is a type-level test, not a runtime assertion.

## Exports are checked, not declarative

The `exports` list cannot lie:

```ts
Module("Persistence")({
  provides: [
    Provider(OrderRepository)({ pool: Pool }, { sync: makeRepository }),
  ],
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
