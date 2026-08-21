---
title: Swap an adapter for tests
description: Wire one application module against a production adapter or an in-memory one, with the type system choosing the entry point each graph is allowed to use.
---

# Swap an adapter for tests

> **How-to.** Compose one application module against two adapters and let the
> compiler pick the entry point. For _why_ a module's exports are what make
> adapters interchangeable, see
> [Modules and privacy](/explanation/modules-and-privacy).

**Goal:** one application module, two persistence adapters — a production one
backed by a real pool, an in-memory one for tests — swappable at the
composition root without touching the application.

This is the seam `di` is built around. The full version, compiled and tested,
is [Hexagonal order API](/examples/hexagonal-order-api); the samples below are
lifted from it.

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
          sync: ({ pool }) => ({
            findById: (id) => {
              const row = pool.findById(id);
              return (
                row === undefined ? Err(new OrderNotFound({ id })) : Ok(row)
              ).toAsync();
            },
          }),
        },
      ),
    ],
    exports: [OrderRepository], // Pool stays internal
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
      Provider(GetOrder)(
        { orders: OrderRepository },
        { class: GetOrderInteractor },
      ),
    ],
    exports: [GetOrder],
  });
```

`Module<OrderRepository, E, N>` says: any module whose exports include
`OrderRepository`, whatever it may fail with, whatever it still needs. Both
channels flow through into the resulting application module — which is what
makes the next step work.

## Composition roots: the types pick the entry point

```ts
// Production: the graph needs Scope (Pool is resourceful), so only
// Module.scoped — which opens a scope and guarantees its close — accepts it.
const result = await Module.scoped(
  makeAppModule(makePersistenceModule()),
  (ctx) => ctx.get(GetOrder).execute("o-1"),
);

// Tests: nothing resourceful, Needs is never, Module.build accepts it.
const built = await Module.build(makeAppModule(InMemoryPersistenceModule));
```

The wrong pairing does not compile:

```ts
// error TS2554: Expected 3 arguments, but got 1.
await Module.build(makeAppModule(makePersistenceModule()));
```

`Scope` is still in `Needs`, so the call's arity gate rejects it before
anything runs. The message is the arity line and nothing more — the
`UNSATISFIED DEPENDENCIES` label and the missing port are in the rest
parameter's type, and hand-spelling the phantom arguments is what prints them
(`Argument of type 'number' is not assignable to parameter of type 'Scope'`,
once the label is passed through first). A test that quietly wires the
production adapter into a scope-less build breaks at compile time, not in CI at
midnight. Passing the
in-memory module to `Module.scoped` is fine — `Scope` is simply absent from
its `Needs`, and a scope that releases nothing is harmless.

## In a test file

```ts
it("returns the order", async () => {
  const result = await Module.build(
    makeAppModule(InMemoryPersistenceModule),
  ).flatMap((ctx) => ctx.get(GetOrder).execute("o-1"));
  expect(result).toBeOkWith({ id: "o-1", total: 99 });
});
```

`toBeOkWith` is [`@unthrown/vitest`](https://github.com/btravstack/unthrown)'s
matcher — one deep assertion, the style this repo's own suites use.

## The same seam under the kernel

An application booted by `start` swaps adapters the same way, one level up:
compose a root that imports the stub persistence module in place of the real
one and hand it to `@btravstack/testing`'s `boot`, which starts
it and stops it again when the test ends, whatever the body does.
`examples/order-api`'s `test-fixtures.ts` does exactly this — a
`persistenceOf(repository)` module providing `OrderRepository` as a `value`,
and an `apiWith(repository)` root that is `HttpModule` over the real
application modules plus that stub. They never learn which one they got. See [Test an application](/how-to/test-an-application).

## See also

- [Keep a port private](/how-to/keep-a-port-private) — why `Pool` never
  leaks out of the production module.
- [Manage a resource's lifetime](/how-to/manage-a-resource) — what
  `acquire`/`release` guarantee.
- [Entry points](/reference/di/entry-points) — `Module.build` and
  `Module.scoped`, precisely.
