---
title: Hexagonal order API example
description: The container on its own — application-named ports, a private connection pool behind a public repository, one application module wired against a production adapter or an in-memory one, and the two guarantees that exist only at compile time, pinned by a type test.
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
class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
declare const ConfigModule: Module<AppConfig, never, never>;
declare const openPool: (deps: {
  readonly config: ServiceOf<AppConfig>;
}) => AsyncResult<PoolClient, never>;

import { expect } from "vitest";
declare const options: { readonly onTeardownError: (portId: string, cause: unknown) => void };
-->

# Hexagonal order API (di alone)

[`examples/hexagonal-order-api`](https://github.com/btravstack/btravstack/tree/main/examples/hexagonal-order-api)
— `@btravstack/di` without the kernel: one use case, one port for its
repository, a resourceful production adapter and a resource-free in-memory
one, and a composition seam generic enough to wire the same application
against either. It composes a `Module` and never calls `start`, which is what
makes it the container's own test rather than the framework's. It is
[Swap an adapter for tests](/how-to/swap-an-adapter)'s and
[Keep a port private](/how-to/keep-a-port-private)'s material, as real code.

```sh
pnpm turbo run test --filter=@btravstack/example-hexagonal-order-api
```

Everything is in memory; nothing else is needed.

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
and never names an adapter:

```ts
export class GetOrderInteractor {
  private readonly orders: ServiceOf<OrderRepository>;
  constructor({ orders }: { readonly orders: ServiceOf<OrderRepository> }) {
    this.orders = orders;
  }
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.orders.findById(id);
  }
}
```

**Adapters** — the production module acquires the pool and exports only the
repository; the in-memory module provides the repository as a plain `value`:

```ts
export const makePersistenceModule = () =>
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
    exports: [OrderRepository],
  });

export const InMemoryPersistenceModule = Module("InMemoryPersistence")({
  provides: [
    Provider(OrderRepository)({
      value: { findById: (id) => Ok({ id, total: 99 }).toAsync() },
    }),
  ],
  exports: [OrderRepository],
});
```

`ConfigModule` is the example's own — a stand-in `Env` as a `value` and an
`AppConfig` `make` that answers a `ConfigError` when the variable is unset. Under
the kernel that slice is [`Config.provider`](/reference/config) reading the
`Env` port `start` supplies; here it is what the shape looks like with nothing
but `di`.

**The seam** — generic in the adapter's channels, so both compositions reuse
it:

```ts
export const makeAppModule = <E, N>(
  persistence: Module<OrderRepository, E, N>,
) =>
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

## What the spec proves

`src/index.spec.ts` builds **both** graphs and exercises them end to end: the
production composition through `Module.scoped` — a found order comes back
`Ok`, a missing one comes back as a tagged `OrderNotFound` failure, and the
scope closes with zero teardown errors, observed through `ScopedOptions`'
`onTeardownError` — and the in-memory composition through `Module.build`,
with no scope required.

```ts
const outcome = await Module.scoped(
  makeAppModule(makePersistenceModule()),
  (ctx) => ctx.get(GetOrder).execute("0199a1e0-0000-7000-8000-000000000001"),
  options,
);

expect(outcome).toBeOkWith({
  id: "0199a1e0-0000-7000-8000-000000000001",
  total: 4_200,
});
```

## What the type-level test pins

Two guarantees in this example exist only at compile time, so
`src/index.test-d.ts` pins them with `@ts-expect-error`:

- `ctx.get(Pool)` on a built application context **does not compile** — the
  port class is exported (plain TypeScript `export`, so the test can name it),
  but the DI module never lists it in `exports`, and that is the boundary that
  counts. ([Modules and privacy](/explanation/modules-and-privacy).)
- `Module.build(makeAppModule(makePersistenceModule()))` **does not compile**
  — `Scope` is still in `Needs`, and only `Module.scoped` may discharge it.
  Running that line for real would leak the very pool the test exists to
  protect, which is exactly why it is a type-level test.
  ([Scopes and resource safety](/explanation/scopes-and-resources).)

## The declaration-emit fixture

The package also carries `src/emit-guards.ts` — **not example code**, and its
header says so. It is a consumer-side fixture that exports ports and providers
the way a downstream library would, compiled with `declaration: true` under
**two** TypeScript versions (the repo's and a consumer's) so the emitted
`.d.ts` stays free of unnameable private types. It is the reason `PortClass`
and `ManyPortClass` are exported from `@btravstack/di` at all, and what keeps
`PortClassOf`/`PortInstance` sufficient for a provider whose port was minted
in a helper — a container-maintenance concern, incidental to what the example
teaches, and the reason this example survived the merge into this repository
when its two siblings did not.

## Where next

- [The order application](/examples/order-application) — the same layering
  under the kernel, booted by three runtimes.
- [Swap an adapter for tests](/how-to/swap-an-adapter) — the seam as a
  recipe.
- [Ports](/reference/di/ports) — `PortClassOf` and friends, precisely.
