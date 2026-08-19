# @btravstack/http

> The HTTP starter for [`@btravstack/core`](../core): oRPC over `node:http`,
> one unit per request, and a drain that actually stops accepting. There is
> **one** way HTTP is answered here — an oRPC contract, implemented as a
> `Result`-returning record — and it is enforced, not offered among
> alternatives.

📖 **[Documentation](https://btravstack.github.io/start/how-to/serve-orpc-over-http)** ·
[Reference](https://btravstack.github.io/start/reference/http) ·
[API Reference](https://btravstack.github.io/start/api/http/)

```sh
pnpm add @btravstack/http @btravstack/core @btravstack/config @btravstack/di unthrown \
  @orpc/server @orpc/contract @unthrown/orpc
```

All of those are peer dependencies — install every one, so the application
holds a single copy of each. Node `>=20`. Not yet published: this repository
has not cut a release yet.

## A worked example

```ts
import { runMain } from "@btravstack/core";
import { HttpModule, HttpRouter } from "@btravstack/http";
import { P } from "unthrown";

// Contract-first: the record is shaped like the contract, each leaf a plain
// Result-returning function typed by it. The use cases arrive as arguments —
// di injects them; oRPC's context stays empty.
const ordersRouter = HttpRouter(ordersContract)([PlaceOrder, FindOrder], {
  sync: (place, find) => ({
    place: ({ errors }, input) =>
      place
        .execute(input.id, input.quantity)
        .map(view)
        // The one place a domain error becomes a transport one — exhaustive,
        // so a new domain error is a compile error right here.
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

// A di module that also knows about its router: imports the starter, provides
// the router on the starter's own port (a process serves one router, so
// there is nothing to name), exports the runtime port — nothing else to spell.
const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [Application, Persistence],
});

await runMain(OrdersApi);
```

That is a whole `main.ts`. `PORT` (default `3000`), `HOST` (default `0.0.0.0`)
and the kernel's `PROBE_PORT` are read inside the graph; the router is mounted
under `/rpc`; a test boots the same module with
`start(OrdersApi, { env: { PORT: "0", HOST: "127.0.0.1" } })` and reads the bound
port back from `app.runtimeInfo()`.

## Splitting a large API into slices

`HttpRouter(contract)(deps, { sync })` is right for a small API; a large one
splits into **controllers**, one per slice of the contract, composed at the
root by a keyed call instead:

```ts
const ordersController = HttpController("OrdersController", ordersContract)(
  [PlaceOrder, FindOrder],
  {
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
  },
);

const orderRouter = HttpRouter(orderContract)({
  orders: ordersController,
  customers: customersController,
});
```

`HttpController(name, fragment)([deps], { sync })` is the same two-call shape
as `HttpRouter`, aimed at one fragment: it mints a port under `name` and
returns the provider carrying it on `.port`. The keyed form is **exact** — a
missing slice, an undeclared key and a controller under the wrong key are all
compile errors — and because a fragment is itself a valid contract, a slice
can be served alone, its controller unchanged: the lifted root is
`HttpRouter(ordersContract)([ordersController.port], { sync: (implementation) => implementation })`,
declaring the very provider the modulith composed. See
[Split a router into controllers](https://btravstack.github.io/start/how-to/split-a-router-into-controllers).

## Protecting a procedure

A contract can say a procedure needs an authenticated caller. The marker is
`@btravstack/contract`'s, so it lives in the artifact a client holds too:

```ts
import { auth } from "@btravstack/contract";
import {
  HttpAuthenticator,
  HttpModule,
  HttpRouter,
  Unauthenticated,
} from "@btravstack/http";
import { oc, type } from "@orpc/contract";
import { ErrAsync, OkAsync, P } from "unthrown";

type Principal = { readonly userId: string; readonly tenantId: string };

const { authenticated } = auth<Principal>();

const ordersContract = authenticated({
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
});

// An ordinary di provider on the starter's port: `deps` are di's, so a JWT
// verifier or a user directory is injected the way any provider's are. The
// principal type is stated at the call rather than inferred from `sync` —
// inference through the returned function's AsyncResult is exactly where it
// would silently widen to `unknown`.
const bearerAuthenticator = HttpAuthenticator<Principal>()([], {
  sync: () => (headers) => {
    const [tenantId, userId] = (headers.authorization ?? "")
      .replace("Bearer ", "")
      .split(":");
    return tenantId === undefined || userId === undefined
      ? ErrAsync(new Unauthenticated({ reason: "no usable bearer token" }))
      : OkAsync({ tenantId, userId });
  },
});

// The principal arrives on oRPC's own context channel, typed by the contract.
const ordersRouter = HttpRouter({ orders: ordersContract })([FindOrder], {
  sync: (find) => ({
    orders: {
      find: ({ context, errors }, input) =>
        find
          .execute(context.principal.tenantId, input.id)
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
});

const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  authenticator: bearerAuthenticator,
  imports: [Application, Persistence],
});
```

A marked router carries the authenticator port as a **need**, so forgetting
`authenticator` is an unmet dependency `start` refuses, and supplying one that
resolves a different principal is a compile error at the `HttpModule(...)` call.
A marked record protects every procedure beneath it. `Unauthenticated` carries a
`reason` that is **yours**: the starter does not surface it — a rejected caller
gets an `UNAUTHORIZED` and nothing derived from the refusal — so an
authenticator that wants the reason recorded logs it itself. See
[Protect a procedure](https://btravstack.github.io/start/how-to/protect-a-procedure).

## What it guarantees

Every request produces exactly one completed response, and its unit stays open
until that response is on the wire — the kernel's least-checkable contract,
made structural. A procedure's output or the `ORPCError` its `Result` was
mapped to is oRPC's; a defect inside a procedure is oRPC's own
`INTERNAL_SERVER_ERROR` collapse; an unmatched path is the package's `404`.
`Result` → HTTP status is the router's `.result()` triage — this package maps
nothing. The drain retires busy keep-alive connections; a client's
`x-request-id` becomes the unit's `traceId`. The rest is on the
[documentation site](https://btravstack.github.io/start/reference/http).

## What it does not do

- **Any other router or handler.** oRPC through `@orpc/server/node`'s
  `RPCHandler` is the one way HTTP is answered here; there is no `handler`
  option and no listener port to provide.
- **A middleware slot for application logic.** oRPC's own middleware, inside
  the router's procedures, is where that belongs. The one the package installs
  itself is `principalMiddleware`, on a marked leaf only. `plugins` is an
  honest escape hatch rather than a keyhole — an oRPC plugin's `init`
  transforms handler options **including interceptors**, so an application
  determined to see a procedure's outcome can get there. What the option buys
  is that the ordinary path — CORS, body limits, compression, CSRF — is
  configuration a reader can see at the composition root. An application
  middleware acting on the handler's `Result` is still what this package
  refuses, because it is the one that puts a use case's outcome in the
  transport's hands.
- **`Result` → HTTP status.** The router's `.result()` triage owns it, in the
  application.
- **Rate limiting.** A per-process counter is the wrong unit: an `api`
  deployment is N pods, so a per-process budget is N independent budgets and
  none of them is the limit anybody meant. The ingress or gateway is where a
  request count is counted once — and an application that wants one anyway
  writes an oRPC plugin and passes it through `plugins`.
- **Authorization.** "May this caller do this?" usually depends on the
  resource — the order's owner, its state, the row's tenant — which cannot be
  answered before the handler has run and fetched it. Authentication, "is
  there a principal and what is it?", is answerable before dispatch, and is
  the only half the contract carries.
- **HTTPS, HTTP/2.** `node:http` only; terminate TLS at the ingress.

## License

[MIT](./LICENSE) © Benoit TRAVERS
