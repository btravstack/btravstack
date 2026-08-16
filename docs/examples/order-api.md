---
title: Order API example
description: The HTTP deployment — two slices, orders and customers, each its own contract fragment and HttpController, composed by the keyed HttpRouter form into one HttpModule root, RequestModule forked per request, a main.ts that is one runMain call with the kernel's events on the application's own logger, and the three compile-time gates pinned by needs-gate.test-d.ts.
---

# Order API (HTTP)

[`examples/order-api`](https://github.com/btravstack/start/tree/main/examples/order-api)
— the first deployment: [the order application](/examples/order-application)
answering callers over oRPC, served by [`@btravstack/http`](/reference/http).

```sh
pnpm turbo run test --filter=@btravstack/example-order-api
```

The specs run a real `node:http` server and a real oRPC client over it, on an
ephemeral port; nothing else is needed.

## Two slices, each its own fragment and controller

The contract splits into two fragments, `orders` and `customers`, each a
`RouterContract` in its own right:

```ts
export const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  find: oc
    .input(type<OrderRef>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
};

export const customersContract = {
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<CustomerView>())
    .errors({ NOT_FOUND: { data: type<{ readonly id: string }>() } }),
};

export const orderContract = {
  orders: ordersContract,
  customers: customersContract,
};
```

Each slice lives under `slices/<name>/` — a `controller.ts` implementing that
slice's fragment, its own domain (`slices/customers/directory.ts`), and a
`module.ts` exporting only its controller's port:

```
src/slices/orders/controller.ts       HttpController("OrdersController", ordersContract)([PlaceOrder, FindOrder], { sync })
src/slices/orders/module.ts           OrdersSlice — provides the controller, exports only its port
src/slices/customers/directory.ts     CustomerDirectory — the slice's own adapter
src/slices/customers/controller.ts    HttpController("CustomersController", customersContract)([CustomerDirectory], { sync })
src/slices/customers/module.ts        CustomersSlice — same shape as OrdersSlice
```

`slices/orders/controller.ts` is the transport boundary and the only place in
this slice where a domain error becomes something else — `slices/customers/controller.ts`
below does the same for its own slice:

```ts
export const ordersController = HttpController(
  "OrdersController",
  ordersContract,
)([PlaceOrder, FindOrder], {
  sync: (place, find) => ({
    place: ({ errors }, input) =>
      place
        .execute(input.id, input.quantity)
        .map(view)
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              errors.INVALID_QUANTITY({
                message: error.message,
                data: { id: error.id },
              }),
            )
            .with(P.tag("DuplicateOrder"), (error) =>
              errors.CONFLICT({
                message: error.message,
                data: { id: error.id },
              }),
            ),
        ),
    find: ({ errors }, input) =>
      find
        .execute(input.id)
        .map(view)
        .mapErrCases((matcher) =>
          matcher.with(P.tag("OrderNotFound"), (error) =>
            errors.NOT_FOUND({
              message: error.message,
              data: { id: error.id },
            }),
          ),
        ),
  }),
});
```

Each leaf is the `.result()` handler `@unthrown/orpc` gives that procedure's
implementer, typed by the contract at the call — the input is the fragment's
parsed input, `errors` its declared error map, and a typo'd or missing
procedure is a compile error **inside the controller**, not at the root. In
it, `Ok` is the output, an `Err` holding an `ORPCError` is **returned** (so
oRPC marks it inferable and the client gets it typed), and a `Defect`
rethrows its cause onto oRPC's own defect path, where it collapses to
`INTERNAL_SERVER_ERROR`.

The `mapErrCases` in between is the triage. Every case of the use case's
error type is named — this repository bans `P._`, and the matcher has no
`.otherwise()` — so a new domain error is a compile error here, at the one
place that has to decide what a client sees. A `Defect` is never named: it
was never modeled, and collapsing it to a 500 is the correct treatment rather
than a fallback.

`slices/customers/controller.ts` is the same shape over one procedure, built
from `slices/customers/directory.ts`'s own `CustomerDirectory` port — a slice
owns its adapter, which is what makes it liftable into a service of its own.

## The router: composed from controllers, keyed by the contract

`module.ts`'s `orderRouter` is `HttpRouter(orderContract)`'s **keyed** form —
a record of controllers, one per top-level contract key, instead of one
`sync`:

```ts
export const orderRouter = HttpRouter(orderContract)({
  orders: ordersController,
  customers: customersController,
});
```

This form is exact: a slice missing from the record, a key the contract does
not declare, and a controller wired under the wrong key are all compile
errors at this call — see
[Split a router into controllers](/how-to/split-a-router-into-controllers) for
the recipe, and `packages/http/src/controller.test-d.ts` for the five gates
that pin these errors and the lift below. Because a fragment is itself a valid
contract, `ordersController` serves `ordersContract` alone unchanged: the
lifted root is
`HttpRouter(ordersContract)([ordersController.port], { sync: (implementation) => implementation })`
over `OrdersSlice`, so extracting a slice out of this modulith is a new
composition root and one fewer import, not a rewrite.

## The composition root, and the process

`module.ts` is the only file that knows the five halves exist:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [
    ApplicationModule,
    PersistenceModule,
    OrdersSlice,
    CustomersSlice,
    observability(),
  ],
  exports: [Logger],
});
```

`HttpModule` imports the starter (`http()` — `HttpRuntime`, `HttpConfig` bound
from `PORT` / `HOST`, the router mounted under `/rpc`, needing the router the
root provides), provides `orderRouter` and exports `HttpRuntime`, and returns
exactly the module `Module("OrderApi")({...})` would have.
`ApplicationModule` leaves `OrderRepository` unmet and `PersistenceModule`
provides it; `OrdersSlice` and `CustomersSlice` each provide their own
controller, which `orderRouter` composes above.
[`observability()`](/reference/observability) brings the `Logger` the
interactors and the request scope write to — bound from `LOG_LEVEL`, one JSON
object per line on stdout, every line carrying the unit's trace id — and
`Logger` is exported for the request scope below. It is a **constant**:
configuration is read inside the graph from the `Env` port the kernel provides,
so nothing is passed in from `main.ts`, and a spec boots this very module with
`env: { PORT: "0", HOST: "127.0.0.1" }`.

`main.ts` is one statement:

```ts
await runMain(OrderApi, {
  unit: RequestModule,
  onEvent: kernelEvents(createLogger(jsonSink())),
});
```

The process reads `PORT` (default `3000`), `HOST` (default `0.0.0.0`),
`LOG_LEVEL` (default `info`) and `PROBE_PORT` (default `9000`) — inside the
graph — and a malformed one is a `startFailed` event and exit `78`.
`kernelEvents` puts the kernel's nine lifecycle events in the same stream and
the same shape as the application's own lines, instead of the default JSON on
stderr; the logger there is built by hand because `building` is emitted while
the graph still is, so a sink taken out of the context it is watching would
have nothing to write the two events that matter most with. See
[Log and correlate](/how-to/log-and-correlate).

## A request scope over the application scope

The application scope is opened once, by the kernel, and holds the database;
opening another per request would give every request its own empty in-memory
database. So `request-scope.ts` declares what lives for one request, and the
kernel forks it:

```ts
export class RequestSpan extends Port("RequestSpan")<{
  readonly finish: () => void;
}> {}

export const RequestModule = Module("Request")({
  provides: [
    Provider(RequestSpan)([Logger], {
      sync: (logger) => {
        const startedAt = Date.now();
        return {
          finish: () =>
            logger.info("request finished", {
              durationMs: Date.now() - startedAt,
            }),
        };
      },
      onStop: (span) => span.finish(),
    }),
  ],
  exports: [RequestSpan],
});
```

Passed as `StartOptions.unit`, it is built as the request opens and torn down
as it closes, reading `Logger` out of the parent without rebuilding it.
`onStop` runs while the unit is still open, which is what gives its line the
request's own trace id — and no handler code manages the fork. See
[Open a per-request scope](/how-to/open-a-per-request-scope).

## The spec: booting the real module on `PORT=0`

`test-fixtures.ts` starts from `@btravstack/testing`'s `bootFixture` and
wraps it in `serve`, where every spec starts, real composition root included:

```ts
export const it = test.extend<ApiFixtures>({
  boot: bootFixture({
    env: { PORT: "0", HOST: "127.0.0.1", LOG_LEVEL: "fatal" },
  }),

  serve: async ({ boot }, use) => {
    await use((module, options) =>
      boot(module, { unit: RequestModule, ...options }),
    );
  },
  // …
});
```

`boot` brings a test's defaults (`signals: false`, `probes: false`,
`preDrainDelayMs: 0`, a silent sink) and stops every app it started when the
test ends; `serve` adds the per-request `RequestModule`, and `LOG_LEVEL:
"fatal"` keeps the real root — whose sink is the production `jsonSink()` on
stdout — out of the runner's own output. The port comes back
from `Serving.info` through `app.runtimeInfo()` — the kernel's own channel
for it — and the client is built from the contract alone. Where a spec needs
the lines the running graph wrote, the seam is
`observability({ sink })`: the `recording` fixture composes the root's shape
with a sink that keeps every `Line`, so an assertion reads `line.unit.traceId`
as a field rather than parsing a prefix out of a string. The suite then pins what matters: a `DuplicateOrder` arrives as an
`Err` holding an inferable `CONFLICT`, a value the client matches by code, not
a thrown 500:

```ts
expect(conflict).toBeErrWith(
  expect.objectContaining({
    constructor: ORPCError,
    code: "CONFLICT",
    data: { id: "o-1" },
    inferable: true,
  }),
);
```

An unmodeled repository failure collapses to `INTERNAL_SERVER_ERROR` without
leaking its message, and the process keeps serving afterwards; each call runs
in its own unit with its own trace id (two calls, four log lines, two distinct
`line.unit.traceId`s, none written outside a unit); a call held open in the
repository finishes during a drain
and is counted `completed`, one still hung at a zero deadline is counted
`abandoned`; `/livez` and `/readyz` answer while serving, and readiness goes
false before liveness during the drain; and the `customers` slice answers
from its own directory over the same client and the same running root,
proving the keyed router actually mounted both controllers rather than one.

## Three gates, pinned at compile time

`needs-gate.test-d.ts` is type-checked, never executed. It pins the two
directions of `start`'s own gate and di's, side by side:

```ts
// @ts-expect-error — NO RUNTIME: the module exports no port declared over RuntimePort.
const _missingRuntime = start(RuntimelessApi, options);
```

`RuntimelessApi` is the same graph without `http(...)`: `start`'s phantom
rest tuple becomes a required argument naming the absence, and the call fails
on arity.

```ts
const RouterlessApi = Module("RouterlessApi")({
  imports: [ApplicationModule, PersistenceModule, observability(), http()],
  exports: [HttpRuntime, Logger],
});

// @ts-expect-error — the composition needs the router port and nothing provides it.
const _missingRouter = start(RouterlessApi, options);
```

This one is **di's** gate, not the kernel's: `http()`'s runtime provider
depends on the starter's own router port through di, so a composition that
imports the starter without providing the router carries an unmet need, and
`start` — which accepts only `Scope | Env` outstanding — refuses the module.
There is no `UNSATISFIED RUNTIME NEEDS` arm here, because the shipped runtime
declares no needs.

```ts
// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
```

The `unit` half, in both directions: `start(OrderApi, { unit: RequestModule })`
is an ordinary call because `OrderApi` exports the `Logger` the fork reads,
and `UnloggedApi` — runtime and router present, `observability()` imported so
the port exists in the graph, `Logger` simply not exported — is
rejected by the unit arm alone.

## Where to go next

- The same `DuplicateOrder`, orchestrated: [Order Temporal worker](/examples/order-temporal-worker).
- The package behind the transport: [`@btravstack/http`](/reference/http).
- Why the kernel appears in none of this: [The kernel maps nothing](/explanation/the-kernel-maps-nothing).
