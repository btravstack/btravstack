# `@btravstack/core` example: the order application layer

The use cases, and the ports they need to run. This layer turns the domain's
rules into operations — "place an order", "find an order" — and declares, as
`@btravstack/di` ports, what it needs the outside world to supply.

```
src/ports.ts          OrderRepository, Outbox, StockService, ShippingService, PlaceOrder, FindOrder
src/use-cases.ts      the interactors, and their providers
src/module.ts         ApplicationModule
src/test-fixtures.ts  the stub repository and TestModule, as Vitest fixtures
```

## The port is declared by the caller, not the adapter

```ts
export class OrderRepository extends Port("OrderRepository")<{
  readonly save: (order: Order) => AsyncResult<Order, DuplicateOrder>;
  readonly find: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
```

`OrderRepository` lives here because the use cases own the shape they need. Its
error channel is spelled in the _domain's_ vocabulary — `DuplicateOrder`, not a
Postgres `23505` or a Prisma `P2002` — so an adapter's job is to translate into
these terms, and no database code can widen what the use cases have to handle.

## `ApplicationModule` does not provide `OrderRepository`

```ts
export const ApplicationModule = Module("Application")({
  provides: [placeOrderProvider, findOrderProvider],
  exports: [PlaceOrder, FindOrder],
});
```

Both interactors depend on `OrderRepository` and nothing here provides it, so di
propagates it as an unmet _need_. `Logger` is the second one, for the same
reason and from the other direction: it is `@btravstack/observability`'s port,
not this layer's, so there is nothing here to provide and nothing to re-export. `Module.scoped(ApplicationModule, …)` is
therefore a compile error — di's gate turns the module's remaining needs into a
required argument naming them (`src/needs-gate.test-d.ts` pins both directions).
The hole is not documentation; it is the type. An infrastructure module fills
it, and only then does the graph build.

## Testable with no infrastructure at all

That hole is also why this layer's specs need no database. `src/test-fixtures.ts`
provides a stub repository from a module declared alongside the spec, and injects
it as a Vitest fixture:

```ts
const testModuleWith = (sink: Sink) =>
  Module("Test")({
    imports: [ApplicationModule, observability({ sink, level: "trace" })],
    provides: [stubRepository, Provider(Env)({ value: {} })],
    exports: [PlaceOrder, FindOrder],
  });
```

Five specs cover placement, persistence, the duplicate path, the domain rule and
the log line — with no Prisma, no HTTP and no kernel booted. `observability()`
binds its level from the `Env` port `start` normally provides, so a kernel-free
spec provides an empty one itself; the `sink` is the seam a spec reads lines
back through.

## Logging is attributes, not sentences

```ts
this.#logger.info("placing an order", { orderId: id, quantity });
```

The message is a constant and the ids are fields, which is what makes a line
groupable in the system that receives it — and what lets the spec assert
`attributes: { orderId: "o-1", quantity: 2 }` rather than match a substring.
Correlation is not this layer's job either: `@btravstack/observability`'s logger
reads `currentUnit()` on every call, so each line carries the trace id of
whatever unit the runtime opened around it. In these specs there is no unit, so
`line.unit` is `undefined` — which the spec asserts.

Nothing here knows the kernel exists: the use cases, the ports and the module
are all plain di, and the layer runs unchanged under a test runner, an HTTP
server or a worker.

## Running it

```bash
pnpm --filter @btravstack/example-order-application test        # 5 specs
pnpm --filter @btravstack/example-order-application test:types  # the needs gate
```
