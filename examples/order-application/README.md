# `@btravstack/start` example: the order application layer

The use cases, and the ports they need to run. This layer turns the domain's
rules into operations — "place an order", "find an order" — and declares, as
`@btravstack/di` ports, what it needs the outside world to supply.

```
src/ports.ts          OrderRepository, Logger, PlaceOrder, FindOrder
src/use-cases.ts      the interactors, and their providers
src/logger.ts         the Logger adapter — the one kernel touchpoint
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
  provides: [loggerProvider, placeOrderProvider, findOrderProvider],
  exports: [PlaceOrder, FindOrder, Logger],
});
```

Both interactors depend on `OrderRepository` and nothing here provides it, so di
propagates it as an unmet _need_. `Module.scoped(ApplicationModule, …)` is
therefore a compile error — di's gate turns the module's remaining needs into a
required argument naming them (`src/needs-gate.test-d.ts` pins both directions).
The hole is not documentation; it is the type. An infrastructure module fills
it, and only then does the graph build.

## Testable with no infrastructure at all

That hole is also why this layer's specs need no database. `src/test-fixtures.ts`
provides a stub repository from a module declared alongside the spec, and injects
it as a Vitest fixture:

```ts
const TestModule = Module("Test")({
  imports: [ApplicationModule],
  provides: [stubRepository],
  exports: [PlaceOrder, FindOrder, Logger],
});
```

Five specs cover placement, persistence, the duplicate path, the domain rule and
the log line — with no Prisma, no HTTP and no kernel booted.

## The single kernel touchpoint

`src/logger.ts` imports exactly one thing from `@btravstack/start`:

```ts
import { currentUnit } from "@btravstack/start";
```

One `Logger` is constructed per scope, but the kernel opens a _unit_ per request
or per job, each with its own trace id. Reading `currentUnit()` fresh inside
`info` — rather than capturing it at construction — is what makes each line
attributable to the unit that wrote it. Outside a unit (this package's specs,
for instance) there is none, and the line reads `[-]`.

Nothing else here knows the kernel exists: the use cases, the ports and the
module are all plain di, and the layer runs unchanged under a test runner, an
HTTP server or a worker.

## Running it

```bash
pnpm --filter @btravstack/start-example-order-application test        # 5 specs
pnpm --filter @btravstack/start-example-order-application test:types  # the needs gate
```
