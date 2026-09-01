# `@btravstack/core` example: the order application layer

The use cases, and the ports they need to run. This layer turns the domain's
rules into operations — "place an order", "find an order" — and declares, as
`@btravstack/di` ports, what it needs the outside world to supply.

```text
src/ports.ts          OrderRepository, CustomerRepository, Outbox, StockService, ShippingService, PaymentService, PlaceOrder, FindOrder, FindCustomer
src/use-cases.ts      the interactors, and their providers
src/module.ts         OrderApplicationModule, CustomerApplicationModule
src/__tests__/test-fixtures.ts  the stub repositories and TestModule, as Vitest fixtures
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

`PaymentService` is the billing vertical's own port, the same shape as
`StockService` and `ShippingService`: `authorize` answers with the domain's
own permanent failure, `PaymentDeclined` — declared in `order-domain`, not
here, for the same reason `OutOfStock` and `ShippingUnavailable` are: it is a
domain answer a caller is entitled to branch on, whatever adapter happens to
produce it — and `capture` / `refund` promise `never`, because a compensation
must not invent new ways to fail. `order-temporal-worker`'s `BillingModule` is
the adapter; nothing here
provides it.

## One module per vertical, and neither provides its repository

```ts
export const OrderApplicationModule = Module("OrderApplication")({
  provides: [placeOrderProvider, findOrderProvider],
  exports: [PlaceOrder, FindOrder],
});

export const CustomerApplicationModule = Module("CustomerApplication")({
  provides: [findCustomerProvider],
  exports: [FindCustomer],
});
```

The interactors depend on `OrderRepository` and `CustomerRepository`, and
nothing here provides either, so di propagates each as an unmet _need_ of the
module that has it. `Logger` is a need of the orders half only — `PlaceOrder`
writes a line and nothing in the customers vertical does — and it is one for
the same reason from the other direction: it is `@btravstack/observability`'s
port, not this layer's, so there is nothing here to provide and nothing to
re-export. `Module.scoped(OrderApplicationModule, …)` is therefore a compile
error — di's gate turns the module's remaining needs into a required argument
that carries them (`src/needs-gate.test-d.ts` pins each vertical's gate
separately). The message itself is only `Expected 5 arguments, but got 2`: an
arity error prints no type, so the ports are in the rest parameter rather than
in the line — hand-spelling the phantom arguments is what prints them, ending on
`not assignable to parameter of type 'Logger | OrderRepository'`.
The hole is not documentation; it is the type. An infrastructure module fills
it, and only then does the graph build.

Splitting the layer is what makes each gate exact rather than collective: a
consumer of the orders vertical is asked for the orders repository, and a
deployment that never answers a customer question — both workers — imports
neither the use case nor its repository.

## Testable with no infrastructure at all

That hole is also why this layer's specs need no database. `src/__tests__/test-fixtures.ts`
provides stub repositories from a module declared alongside the spec, and
injects it as a Vitest fixture:

```ts
const testModuleWith = (sink: Sink) =>
  Module("Test")({
    imports: [
      OrderApplicationModule,
      CustomerApplicationModule,
      observability({ sink, level: "trace" }),
    ],
    provides: [
      stubRepository,
      stubCustomerRepository,
      Provider(Env)({ inject: {}, value: {} }),
    ],
    exports: [PlaceOrder, FindOrder, FindCustomer],
  });
```

Nine specs cover placement, persistence, the duplicate path, the domain rule,
the malformed id, the tenant boundary, the log line and both arms of the
customer lookup — with no Prisma, no HTTP and
no kernel booted. `observability()`
binds its level from the `Env` port `start` normally provides, so a kernel-free
spec provides an empty one itself; the `sink` is the seam a spec reads lines
back through.

## Logging is attributes, not sentences

```ts
this.#logger.info("placing an order", { tenantId, orderId: id, quantity });
```

The message is a constant and the ids are fields, which is what makes a line
groupable in the system that receives it — and what lets the spec assert
`attributes: { tenantId: "acme", orderId: "0199a1e0-0000-7000-8000-000000000001", quantity: 2 }`
rather than match a substring.
Correlation is not this layer's job either: `@btravstack/observability`'s logger
reads `currentUnit()` on every call, so each line carries the trace id of
whatever unit the runtime opened around it. In these specs there is no unit, so
`line.unit` is `undefined` — which the spec asserts.

Nothing here knows the kernel exists: the use cases, the ports and the module
are all plain di, and the layer runs unchanged under a test runner, an HTTP
server or a worker.

## Running it

```bash
pnpm --filter @btravstack/example-order-application test        # 9 specs
pnpm --filter @btravstack/example-order-application test:types  # the needs gate
```
