# @btravstack/di

> A module-based dependency-injection container for TypeScript: **ports** are
> the vocabulary an application defines for what it needs, **providers** bind a
> port to a construction at one edge, **modules** group them and decide what the
> outside sees — and every wiring mistake the compiler can catch is a compile
> error, not a runtime surprise.

📖 **[Documentation](https://btravstack.github.io/start/reference/di/ports)** ·
[Getting started](https://btravstack.github.io/start/tutorial/getting-started) ·
[API Reference](https://btravstack.github.io/start/api/di/)

```sh
pnpm add @btravstack/di unthrown
```

`unthrown` is a peer dependency. `@btravstack/di` depends on nothing else. Node
`>=20`. Not yet published: this repository has not cut a release yet.

## Ports, providers, modules

```ts
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";

type Order = { readonly id: string; readonly total: number };
class OrderNotFound extends TaggedError("OrderNotFound")<{
  readonly id: string;
}> {}

// A port is named by the domain, never by whatever will implement it.
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
class GetOrder extends Port("GetOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

// A provider binds a port to a construction and declares what it needs — the
// arguments arrive typed from the ports listed, in order.
const getOrder = Provider(GetOrder)([OrderRepository], {
  sync: (orders): ServiceOf<GetOrder> => ({
    execute: (id) => orders.findById(id),
  }),
});

const inMemoryOrders = Provider(OrderRepository)({
  sync: () => {
    const orders = new Map<string, Order>([["o-1", { id: "o-1", total: 42 }]]);
    return {
      findById: (id) => {
        const order = orders.get(id);
        return order === undefined
          ? ErrAsync(new OrderNotFound({ id }))
          : OkAsync(order);
      },
    };
  },
});

// A module groups providers and decides what the outside sees. `GetOrder`
// needs `OrderRepository`; a composition that forgets to provide it does not
// compile.
const Application = Module("Application")({
  provides: [getOrder, inMemoryOrders],
  exports: [GetOrder],
});

// Build the graph, use it, tear it down — on every path.
await Module.scoped(Application, (ctx) => ctx.get(GetOrder).execute("o-1"));
```

The five provider arms — `value`, `sync`, `make` (may fail, with a modeled
error), `class`, `acquire`/`release` (a resource, released when the scope
closes) — the private-by-default modules,
`Module.forkScope` for a per-request scope, and the compile-time gates that
name what is missing are on the [documentation site](https://btravstack.github.io/start/reference/di/ports).
Under [`@btravstack/core`](https://btravstack.github.io/start/reference/core/start), `start(module)` is the
one `Module.scoped` call a process makes.

## License

[MIT](./LICENSE) © Benoit TRAVERS
