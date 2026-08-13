---
title: Swap an adapter for tests
description: Wire one application module against a production adapter or an in-memory one, with the type system choosing the entry point each graph is allowed to use.
---

# Swap an adapter for tests

**Goal:** one application module, two persistence adapters — a production one
backed by a real pool, an in-memory one for tests — swappable at the
composition root without touching the application.

This is the seam `di` is built around. The full version, compiled and
exercised end to end, is the
[hexagonal-order-api example](/examples/hexagonal-order-api).

## The port both adapters implement

```ts
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

The application module depends on this port and nothing else — so any module
that exports it will do.

## The production adapter

Resourceful: the pool is acquired once and must be released, so this module's
`Needs` carries `Scope`:

```ts
const makePersistenceModule = () =>
  Module("Persistence")({
    imports: [ConfigModule],
    provides: [
      Provider(Pool)([AppConfig], {
        acquire: openPool,
        release: (pool) => pool.close(),
      }),
      Provider(OrderRepository)([Pool], {
        sync: (pool) => ({
          findById: (id) => {
            const row = pool.findById(id);
            return (
              row === undefined ? Err(new OrderNotFound({ id })) : Ok(row)
            ).toAsync();
          },
        }),
      }),
    ],
    exports: [OrderRepository], // Pool stays internal.
  });
```

## The test adapter

Nothing to acquire, nothing to release — `Needs` is `never`:

```ts
const InMemoryPersistenceModule = Module("InMemoryPersistence")({
  provides: [
    Provider(OrderRepository)({
      value: { findById: (id) => Ok({ id, total: 99 }).toAsync() },
    }),
  ],
  exports: [OrderRepository],
});
```

## The seam: an application module generic in its adapter

Make the application module a function of the persistence module, generic in
that module's own error and requirement channels:

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

The `Module<OrderRepository, E, N>` constraint says: any module whose exports
include `OrderRepository`, whatever it might fail with, whatever it still
needs. Both channels flow through into the resulting application module — which
is exactly what makes the next step work.

## Composition roots: the types pick the entry point

```ts
// Production: the graph needs Scope (Pool is resourceful), so only
// Module.scoped — which opens a scope and guarantees its close — accepts it.
const result = await Module.scoped(
  makeAppModule(makePersistenceModule()),
  (ctx) => ctx.get(GetOrder).execute("o-1"),
);

// Tests: nothing resourceful, Needs is `never`, Module.build accepts it.
const built = await Module.build(makeAppModule(InMemoryPersistenceModule));
```

The wrong pairing does not compile:

```ts
await Module.build(makeAppModule(makePersistenceModule())); // ✗ UNSATISFIED DEPENDENCIES
```

`Scope` is still in `Needs`, so the call's arity gate rejects it before
anything runs. There is no convention to remember: a test that quietly wires
the production adapter into a scope-less build breaks at compile time, not in
CI at midnight.

Passing the in-memory module to `Module.scoped` is fine, by contrast — `Scope`
is simply absent from its `Needs`, and a scope that releases nothing is
harmless.

## In a test file

```ts
it("returns the order", async () => {
  const result = await Module.build(
    makeAppModule(InMemoryPersistenceModule),
  ).flatMap((ctx) => ctx.get(GetOrder).execute("o-1"));
  await expect(result).toBeOk({ id: "o-1", total: 99 });
});
```

(`toBeOk` is [`@unthrown/vitest`](https://github.com/btravstack/unthrown)'s
matcher — the assertion style the library's own suite uses.)

## Related

- [Keep a port private](/how-to/private-ports) — why `Pool` never leaks out of
  the production module.
- [Manage a resource's lifetime](/how-to/manage-a-resource) — what
  `acquire`/`release` guarantee.
- [Entry points](/reference/entry-points) — `Module.build` and `Module.scoped`,
  precisely.
