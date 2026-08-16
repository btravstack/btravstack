# `@btravstack/core` example: the order application layer

The use cases, and the ports they need to run. This layer turns the domain's
rules into operations — "place an order", "find an order" — and declares, as
`@btravstack/di` ports, what it needs the outside world to supply.

```
src/ports.ts          OrderRepository, CustomerRepository, Outbox, StockService, ShippingService, PlaceOrder, FindOrder, FindCustomer
src/use-cases.ts      the interactors, and their providers
src/module.ts         ApplicationModule
src/test-fixtures.ts  the stub repositories and TestModule, as Vitest fixtures
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

`CustomerRepository` is the same declaration for the customers vertical, and
read-only: nothing in this application registers a customer, so the port says
only what the use case needs. Its `find` answers with the domain's `Customer`,
never the transport's `CustomerView` — an adapter that spoke the wire's shape
would point the dependency arrow outwards.

## `ApplicationModule` does not provide the repositories

```ts
export const ApplicationModule = Module("Application")({
  provides: [placeOrderProvider, findOrderProvider, findCustomerProvider],
  exports: [PlaceOrder, FindOrder, FindCustomer],
});
```

The interactors depend on `OrderRepository` and `CustomerRepository`, and
nothing here provides either, so di propagates both as unmet _needs_ — the gate
holds per port, so adding a vertical added a need rather than an exception.
`Logger` is the third one, for the same
reason and from the other direction: it is `@btravstack/observability`'s port,
not this layer's, so there is nothing here to provide and nothing to re-export. `Module.scoped(ApplicationModule, …)` is
therefore a compile error — di's gate turns the module's remaining needs into a
required argument naming them (`src/needs-gate.test-d.ts` pins both directions).
The hole is not documentation; it is the type. An infrastructure module fills
it, and only then does the graph build.

## Testable with no infrastructure at all

That hole is also why this layer's specs need no database. `src/test-fixtures.ts`
provides stub repositories from a module declared alongside the spec, and
injects it as a Vitest fixture:

```ts
const testModuleWith = (sink: Sink) =>
  Module("Test")({
    imports: [ApplicationModule, observability({ sink, level: "trace" })],
    provides: [
      stubRepository,
      stubCustomerRepository,
      Provider(Env)({ value: {} }),
    ],
    exports: [PlaceOrder, FindOrder, FindCustomer],
  });
```

Seven specs cover placement, persistence, the duplicate path, the domain rule,
the log line and both arms of the customer lookup — with no Prisma, no HTTP and
no kernel booted. `observability()`
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
pnpm --filter @btravstack/example-order-application test        # 7 specs
pnpm --filter @btravstack/example-order-application test:types  # the needs gate
```
