<!-- doctest: prelude
import { HttpModule, defineHttp } from "@btravstack/http-server";
import { Port, type AnyModule } from "@btravstack/di";
import { OkAsync, type AsyncResult } from "unthrown";
import { oc } from "@orpc/contract";
import { otel } from "@btravstack/observability/otel";
import { cache } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";

// The application's own router and slices, declared here so this sample stands
// on the published packages alone.
const api = defineHttp();
const orderRouter = api.OrpcRouter({ orders: { place: oc } })({
  inject: {},
  sync: () => ({ orders: { place: () => OkAsync("placed") } }),
});
declare const OrdersSlice: AnyModule;
declare const CustomersSlice: AnyModule;
class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (id: string, quantity: number) => AsyncResult<void, never>;
}> {}
class OrderRepository extends Port("OrderRepository")<{
  readonly save: (order: {
    readonly id: string;
    readonly quantity: number;
  }) => AsyncResult<void, never>;
}> {}
-->

# @btravstack/observability

> Observability for [`@btravstack/core`](../core), starting with logging: a
> **strict** `Logger` port — no `any`, no printf, no mutable context, no static
> instance — a default implementation that stamps every line with the ambient
> unit's trace id, a dependency-free JSON sink, pino behind a subpath, and the
> kernel's nine lifecycle events as log lines in the same stream.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/observability)** ·
[How-to](https://btravstack.github.io/btravstack/how-to/log-and-correlate) ·
[API Reference](https://btravstack.github.io/btravstack/api/observability/)

```sh
pnpm add @btravstack/observability @btravstack/core @btravstack/config @btravstack/di unthrown
```

Those four are peers. `pino` is an **optional** peer, needed only if you import
`@btravstack/observability/pino`. Node `>=22`.

## A worked example

```ts
import { runMain, Logger } from "@btravstack/core";
import {
  createLogger,
  jsonSink,
  kernelEvents,
  observability,
} from "@btravstack/observability";
import { Module, Provider } from "@btravstack/di";

// The application depends on the port, like any other service.
const placeOrder = Provider(PlaceOrder)({
  inject: { orders: OrderRepository, logger: Logger },
  sync: ({ orders, logger }) => ({
    execute: (id, quantity) =>
      orders
        .save({ id, quantity })
        .tap(() => logger.info("order placed", { id, quantity })),
  }),
});

// The starter provides it. `LOG_LEVEL` is read inside the graph and validated
// once — `verbose` is a startup failure naming the variable, not a silent
// fallback to `info`.
const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [
    OrdersSlice,
    CustomersSlice,
    cache({ adapter: redisCache() }),
    observability(),
    otel(),
  ],
  exports: [Logger],
});

// The kernel's own events, in the same stream and the same shape. The logger
// here is built by hand because `building` is emitted while the graph still
// is: the sink cannot come from the context it is watching.
await runMain(OrderApi, { onEvent: kernelEvents(createLogger(jsonSink())) });
```

Every line written inside a unit carries that unit's `traceId`, `unitId` and
`tenantId` — the logger reads `currentUnit()` **per call**, so one
application-scope logger is correct for every request without a single
argument threaded through the call stack.

```json
{
  "orderId": "0199a1e0-0000-7000-8000-000000000001",
  "time": "2026-08-16T09:41:02.113Z",
  "level": "info",
  "message": "order placed",
  "unitId": "u-7",
  "traceId": "3f9c…"
}
```

## What makes the interface strict

| Decision                                 | Why                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| A **port**, never a class or a static    | A test provides its own; there is no global to reach past DI with                                                   |
| `with(attributes)` returns a logger      | Nothing mutates: two scopes cannot interleave each other's context                                                  |
| `Attributes` is a flat record of scalars | The shape a log backend indexes; no `any`, no printf, no stringifying whatever it is handed                         |
| A failure goes in `cause`                | An `Error`'s `message` and `stack` are non-enumerable — `JSON.stringify` alone drops exactly the part worth keeping |
| It cannot throw                          | A broken sink is swallowed: an observability fault must not become an outage                                        |
| Six levels, fixed                        | `LOG_LEVEL` is validated at startup, and `isEnabled` is a comparison                                                |

## Swapping the implementation

`observability({ sink })` replaces the destination; providing `Logger`
yourself replaces everything. For a deployment that wants pino's throughput:

<!-- doctest: skip — needs `pino`, which no example workspace installs; held by packages/observability/src/pino.spec.ts instead -->

```ts
import pino from "pino";
import { pinoSink } from "@btravstack/observability/pino";

observability({ sink: pinoSink(pino()) });
```

The level filter stays this package's — `LOG_LEVEL`, validated once — so there
is one filter in the process rather than two that can disagree.

## Traces and metrics

The other half of the package's name, behind an optional-peer subpath the way
`pino` is:

```sh
pnpm add @opentelemetry/api @opentelemetry/sdk-node
```

<!-- doctest: skip — needs `@opentelemetry/*`, which no example workspace installs; held by packages/observability/src/otel.spec.ts instead -->

```ts
import { observability } from "@btravstack/observability";
import { UnitSpanModule, otel } from "@btravstack/observability/otel";

// Beside observability() in the root's imports; the SDK is a resource of the
// graph — started with the scope, flushed by release on every exit path.
// Configuration is the OTEL_* environment conventions, read by the SDK itself.
const AppImports = [observability(), otel()];

// A span per unit, correlated with the same ids the logger stamps — bound on
// the starter's own `unit` option and forked by the runtime around each
// request, delivery or activity attempt, e.g.
// http({ unit: { anonymous: UnitSpanModule } })
```

Inbound W3C `traceparent` feeds the unit's trace id in `@btravstack/http-server` and
`@btravstack/amqp-worker`. Auto-instrumentation must be preloaded
(`node --import @opentelemetry/auto-instrumentations-node/register`) — it
cannot be a provider, and the package does not pretend otherwise. Full
semantics on
[the reference page](https://btravstack.github.io/btravstack/reference/observability).

## License

[MIT](./LICENSE) © Benoit TRAVERS
