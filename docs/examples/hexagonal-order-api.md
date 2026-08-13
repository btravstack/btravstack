---
title: Hexagonal order API
description: A compiled hexagonal slice — application-named ports, a private connection pool behind a public repository, and one application module wired against a production adapter or an in-memory one.
---

# Hexagonal order API

**Source:**
[`examples/hexagonal-order-api`](https://github.com/btravstack/di/tree/main/examples/hexagonal-order-api)

The core story, compiled: one use case, one port for its repository, a
resourceful production adapter and a resource-free in-memory one, and a
composition seam generic enough to wire the same application against either.
It is the [tutorial](/tutorial/getting-started)'s and the
[adapter-swapping guide](/how-to/swap-an-adapter)'s material, as real code.

## The layers

**Ports** — named by the domain. `Pool` is the interesting one: a real
resource, and deliberately internal:

```ts
export class Pool extends Port("Pool")<{
  readonly findById: (id: string) => Order | undefined;
  readonly close: () => void;
}> {}

export class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

**Application** — `GetOrderInteractor` depends on `ServiceOf<OrderRepository>`
and never names an adapter.

**Adapters** — the production module acquires the pool and exports only the
repository; the in-memory module provides the repository as a plain `value`:

```ts
export const makePersistenceModule = () =>
  Module("Persistence")({
    imports: [ConfigModule],
    provides: [
      Provider(Pool)([AppConfig], { acquire: openPool, release: (pool) => pool.close() }),
      Provider(OrderRepository)([Pool], { sync: /* ... */ }),
    ],
    exports: [OrderRepository], // Pool stays internal
  });
```

**The seam** — generic in the adapter's channels, so both compositions reuse
it:

```ts
export const makeAppModule = <E, N>(
  persistence: Module<OrderRepository, E, N>,
) =>
  Module("App")({
    imports: [persistence],
    provides: [
      Provider(GetOrder)([OrderRepository], { class: GetOrderInteractor }),
    ],
    exports: [GetOrder],
  });
```

## What the spec proves

`src/index.spec.ts` builds **both** graphs and exercises them end to end: the
production composition through `Module.scoped` — a found order comes back
`Ok`, a missing one comes back as a tagged `OrderNotFound` failure, and the
scope closes with zero teardown errors — and the in-memory composition
through `Module.build`.

## What the type-level test pins

Two guarantees in this example exist only at compile time, so
`src/index.test-d.ts` pins them with `@ts-expect-error`:

- `ctx.get(Pool)` on a built application context **does not compile** — the
  port class is exported (plain TypeScript `export`, so the test can name
  it), but the DI module never lists it in `exports`, and that is the
  boundary that counts.
  ([Modules and privacy](/explanation/modules-and-privacy).)
- `Module.build(makeAppModule(makePersistenceModule()))` **does not
  compile** — `Scope` is still in `Needs`, and only `Module.scoped` may
  discharge it. Running that line for real would leak the very pool the test
  exists to protect, which is exactly why it is a type-level test.

The package also carries the repo's declaration-emit fixture
(`emit-guards.ts`, compiled by two TypeScript versions in `typecheck`) — a
library-maintenance concern, incidental to what the example teaches.

## Run it

```sh
pnpm --filter @btravstack/di-example-hexagonal-order-api test
pnpm --filter @btravstack/di-example-hexagonal-order-api typecheck
```
