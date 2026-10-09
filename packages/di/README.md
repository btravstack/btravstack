# @btravstack/di

> A module-based dependency-injection container for TypeScript: **ports** are
> the vocabulary an application defines for what it needs, **providers** bind a
> port to a construction at one edge, **modules** group them and decide what the
> outside sees — and every wiring mistake the compiler can catch is a compile
> error, not a runtime surprise.

📖 **[Documentation](https://btravstack.github.io/btravstack/di/)** ·
[Getting started](https://btravstack.github.io/btravstack/di/tutorial/getting-started) ·
[API Reference](https://btravstack.github.io/btravstack/api/di/)

```sh
pnpm add @btravstack/di unthrown
```

`unthrown` is a peer dependency. `@btravstack/di` depends on nothing else. Node
`>=22`.

## Ports, providers, modules

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";

type Order = { readonly id: string; readonly total: number };
class OrderNotFound extends TaggedError("OrderNotFound")<{
  readonly id: string;
}> {}

// A port is named by the domain, never by whatever will implement it.
class OrderRepository extends Port("OrderRepository")<{
  readonly findById: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}

// A use case is a class that is its own port and provider: its services
// arrive typed on `this.deps`, under the names the `inject` record gave them.
class GetOrder extends Provider.class("GetOrder", { inject: { orders: OrderRepository } }) {
  execute(id: string): AsyncResult<Order, OrderNotFound> {
    return this.deps.orders.findById(id);
  }
}

// An adapter is a provider binding a declared port to a construction.
const inMemoryOrders = Provider(OrderRepository)({
  inject: {},
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
  provides: [GetOrder, inMemoryOrders],
  exports: [GetOrder],
});

// Build the graph, use it, tear it down — on every path.
await Module.scoped(Application, (ctx) => ctx.get(GetOrder).execute("o-1"));
```

A module also declares what it expects from outside — `needs: [Logger]` — and
one that owes a port and names none does not compile, so a slice never quietly
absorbs whatever the composition root happens to hold.

The five provider arms — `value`, `sync`, `make` (may fail, with a modeled
error), `class`, `acquire`/`release` (a resource, released when the scope
closes) — the private-by-default modules, `Port.many` for a plugin registry,
`Module.forkScope` for a per-request scope, and the compile-time gates that
carry what is missing are on the [documentation site](https://btravstack.github.io/btravstack/reference/di/ports).
Under [`@btravstack/core`](https://btravstack.github.io/btravstack/reference/core/start), `start(module)` is the
one `Module.scoped` call a process makes.

## License

[MIT](./LICENSE) © Benoit TRAVERS
