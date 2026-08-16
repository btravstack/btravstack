---
title: Order API example
description: The HTTP deployment — HttpRouter over the order contract with one exhaustive triage from domain Err to ORPCError, HttpModule as the whole composition root, RequestModule forked per request, a one-line main.ts, and the three compile-time gates pinned by needs-gate.test-d.ts.
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

## The router: contract-first, `Result` at every leaf

`router.ts` is the transport boundary and the only place in the example where
a domain error becomes something else. `HttpRouter(orderContract)("OrderRouter")`
mints the router's port and hands back di's `Provider(port)`, so the router
is a provider like any other — it declares the two use cases its procedures
call, and di injects them. oRPC's own context stays empty.

```ts
export const orderRouter = HttpRouter(orderContract)("OrderRouter")(
  [PlaceOrder, FindOrder],
  {
    sync: (place, find) => ({
      orders: {
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
      },
    }),
  },
);
```

Each leaf is the `.result()` handler `@unthrown/orpc` gives that procedure's
implementer, typed by the contract at the call — the input is the contract's
parsed input, `errors` its declared error map, and a typo'd or missing
procedure is a compile error. In it, `Ok` is the output, an `Err` holding an
`ORPCError` is **returned** (so oRPC marks it inferable and the client gets it
typed), and a `Defect` rethrows its cause onto oRPC's own defect path, where
it collapses to `INTERNAL_SERVER_ERROR`.

The `mapErrCases` in between is the triage. Every case of the use case's
error type is named — this repository bans `P._`, and the matcher has no
`.otherwise()` — so a new domain error is a compile error here, at the one
place that has to decide what a client sees. A `Defect` is never named: it
was never modeled, and collapsing it to a 500 is the correct treatment rather
than a fallback.

## The composition root, and the process

`module.ts` is the only file that knows the three halves exist:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [ApplicationModule, PersistenceModule],
  exports: [Logger],
});
```

`HttpModule` imports the starter (`http({ router: orderRouter.port })` —
`HttpRuntime`, `HttpConfig` bound from `PORT` / `HOST`, the router mounted
under `/rpc`), provides `orderRouter` and exports `HttpRuntime`, and returns
exactly the module `Module("OrderApi")({...})` would have. `Logger` is
exported for the request scope below. It is a **constant**: configuration is
read inside the graph from the `Env` port the kernel provides, so nothing is
passed in from `main.ts`, and a spec boots this very module with
`env: { PORT: "0", HOST: "127.0.0.1" }`.

`main.ts` is one statement:

```ts
await runMain(OrderApi, { unit: RequestModule });
```

The process reads `PORT` (default `3000`), `HOST` (default `0.0.0.0`) and
`PROBE_PORT` (default `9000`) — inside the graph — and a malformed one is a
`startFailed` event and exit `78`.

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
            logger.info(`request finished in ${Date.now() - startedAt}ms`),
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

`test-fixtures.ts`'s `serve` fixture is where every spec starts, real
composition root included:

```ts
const app = start(module, {
  env: { PORT: "0", HOST: "127.0.0.1" },
  unit: RequestModule,
  signals: false,
  probes: false,
  preDrainDelayMs: 0,
  ...options,
});
```

The port comes back from `Serving.info` through `app.runtimeInfo()` — the
kernel's own channel for it — and the client is built from the contract
alone. The suite then pins what matters: a `DuplicateOrder` arrives as an
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
ids, never `[-]`); a call held open in the repository finishes during a drain
and is counted `completed`, one still hung at a zero deadline is counted
`abandoned`; `/livez` and `/readyz` answer while serving, and readiness goes
false before liveness during the drain.

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
  imports: [
    ApplicationModule,
    PersistenceModule,
    http({ router: orderRouter.port }),
  ],
  exports: [HttpRuntime, Logger],
});

// @ts-expect-error — the composition needs OrderRouter and nothing provides it.
const _missingRouter = start(RouterlessApi, options);
```

This one is **di's** gate, not the kernel's: `http({ router })`'s runtime
provider depends on the router port through di, so a composition that imports
the starter without providing the router carries an unmet need, and `start` —
which accepts only `Scope | Env` outstanding — refuses the module. There is no
`UNSATISFIED RUNTIME NEEDS` arm here, because the shipped runtime declares no
needs.

```ts
// @ts-expect-error — UNSATISFIED UNIT NEEDS: the module does not export Logger for RequestModule to read.
const _unitUnmet = start(UnloggedApi, { ...options, unit: RequestModule });
```

The `unit` half, in both directions: `start(OrderApi, { unit: RequestModule })`
is an ordinary call because `OrderApi` exports the `Logger` the fork reads,
and `UnloggedApi` — runtime and router present, `Logger` not exported — is
rejected by the unit arm alone.

## Where to go next

- The same `DuplicateOrder`, orchestrated: [Order Temporal worker](/examples/order-temporal-worker).
- The package behind the transport: [`@btravstack/http`](/reference/http).
- Why the kernel appears in none of this: [The kernel maps nothing](/explanation/the-kernel-maps-nothing).
