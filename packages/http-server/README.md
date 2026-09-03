# @btravstack/http-server

> The **serving half** of HTTP for [`@btravstack/core`](../core): one runtime,
> and a `HttpHandler` set port every protocol contributes one answerer to,
> routed by longest matching mount prefix. Two ship — oRPC over `node:http`
> (a caller reaches it with `@orpc/client` and the contract package, not this
> one) and htmx fragments, server-rendered `Html` escaped by default — each
> with one unit per request and a drain that actually stops accepting. This
> README works the oRPC half end to end; for fragments, see
> [Serve htmx fragments](https://btravstack.github.io/btravstack/how-to/serve-htmx-fragments).

📖 **[Documentation](https://btravstack.github.io/btravstack/how-to/serve-orpc-over-http)** ·
[Reference](https://btravstack.github.io/btravstack/reference/http-server) ·
[API Reference](https://btravstack.github.io/btravstack/api/http-server/)

```sh
pnpm add @btravstack/http-server @btravstack/core @btravstack/config @btravstack/di \
  @btravstack/contract unthrown @orpc/server@^2.0.0-beta @orpc/contract@^2.0.0-beta @unthrown/orpc
```

All of those are peer dependencies — install every one, so the application
holds a single copy of each. Node `>=22`.

## A worked example

<!-- doctest: isolate
import { oc, type } from "@orpc/contract";
import { Port, type Module } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";
// The application's own domain, declared here so this sample stands on the
// published packages alone: these are yours, not this package's.
class InvalidQuantity extends TaggedError("InvalidQuantity")<{
  readonly id: string;
  readonly quantity: number;
}> {}
class InvalidOrderId extends TaggedError("InvalidOrderId")<{ readonly id: string }> {}
class DuplicateOrder extends TaggedError("DuplicateOrder")<{ readonly id: string }> {}
class OrderNotFound extends TaggedError("OrderNotFound")<{ readonly id: string }> {}
type Order = { readonly id: string; readonly quantity: number };
type OrderView = { readonly id: string; readonly quantity: number };
type OrderRef = { readonly id: string };
declare const view: (order: Order) => OrderView;
class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (
    id: string,
    quantity: number,
  ) => AsyncResult<Order, InvalidQuantity | InvalidOrderId | DuplicateOrder>;
}> {}
declare const Persistence: Module<never, never, never>;
class FindOrder extends Port("FindOrder")<{
  readonly execute: (id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      BAD_REQUEST: { data: type<OrderRef>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  find: oc
    .input(type<OrderRef>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
};
declare const Application: Module<PlaceOrder | FindOrder, never, never>;
-->

```ts
import { runMain } from "@btravstack/core";
import { HttpModule, defineHttp } from "@btravstack/http-server";
import { P } from "unthrown";

// One call mints every marker-typed entity this application uses. A public
// API declares no security scheme, so it takes no argument. Hold the result
// as ONE binding — never destructure it (see "Protecting a procedure").
const api = defineHttp();

// Contract-first: the record is shaped like the contract, each leaf a plain
// Result-returning function typed by it. The use cases arrive under the names
// the `inject` record gave them — di injects them; oRPC's context stays empty.
const ordersRouter = api.OrpcRouter(ordersContract)({
  inject: { place: PlaceOrder, find: FindOrder },
  sync: ({ place, find }) => ({
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
            // A malformed id is the caller's mistake, so 400 — not the
            // 409 a duplicate gets.
            .with(P.tag("InvalidOrderId"), (error) =>
              errors.BAD_REQUEST({
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

`api.OrpcRouter(contract)({ inject, sync })` is right for a small API. A large
one splits into **pieces** — one per node of the contract tree, named by a
dotted path — composed at the root as an array instead:

<!-- doctest: skip — an excerpt of two call shapes, not a program: the compiled versions are on /how-to/split-a-router-into-controllers and in examples/order-api -->

```ts
// each slice owns one piece, and exports only its port
export const ordersController = api.OrpcController(contract, "orders")({
  inject: { place: PlaceOrder },
  sync: ({ place }) => ({ place: ({ errors }, input) => placeOrder(place, errors, input) }),
});

// the root composes them; every procedure the contract declares must be covered
export const orderRouter = api.OrpcRouter(contract)([ordersController, customersController]);
```

The key rides the piece's own port id, so a piece cannot sit under the wrong
one; an uncovered procedure and a piece nested inside another's fragment are
each refused at the array, naming what is missing. And because a **fragment is
itself a valid contract**, a slice lifts into a process of its own with its
piece unchanged — which is what makes a modulith a starting point rather than a
trap.

The worked recipe, with the slice modules and the lifted root:
[Split a router into controllers](https://btravstack.github.io/btravstack/how-to/split-a-router-into-controllers).

## Protecting a procedure

A contract says which **security schemes** a procedure accepts and which scopes
each must grant — the marker is `@btravstack/contract`'s, so it lives in the
artifact a client holds too, and it names no identity type, so nothing about the
server's view of a caller reaches a client.

`defineHttp({ authenticators })` says what each scheme **resolves to**.
Declaring a scheme and implementing it are the same act, so there is no registry
to keep in step with the contract:

<!-- doctest: skip — one call shape; the compiled version is in examples/order-api/src/auth.ts, which the doc-samples gate compiles through /how-to/protect-a-procedure -->

```ts
const api = defineHttp({ authenticators: { user: userAuth, service: serviceAuth } });
```

Four consequences, and they are the whole story:

- **A marked procedure's handler receives a typed principal** as
  `({ principal }, input)`, narrowed to the scheme that answered when the
  contract names more than one.
- **The scheme ports are declared by the router**, one per scheme its contract
  names — so a scheme with no authenticator behind it is an unmet dependency
  the compiler reports, naming the port.
- **A caller no requirement accepts gets `401`; a valid credential missing a
  scope gets `403`**, neither with a message, because oRPC serializes `message`
  to the client and a refusal has nothing a caller is entitled to.
- **A defect from an authenticator is a bug, not a refusal**: it stops the walk
  rather than promoting the caller to the next scheme.

Resource-dependent authorization — "may this caller read _this_ order" — stays
in the handler, deliberately: a scope is a property of the credential and
answerable before dispatch, and ownership is not.

The worked recipe:
[Protect a procedure](https://btravstack.github.io/btravstack/how-to/protect-a-procedure).
The full surface, arm by arm:
[`AUTH.md`](./AUTH.md).

## Authenticators

Two ship, because these are the ones where writing it per application is how
CVEs happen — both are ordinary `Authenticator` values bound by name in
`defineHttp({ authenticators })`:

- **`apiKeyAuthenticator<P>()({ keys, header? })`**, on the main entry point. Constant-time
  compare over SHA-256 digests, every key checked with no early return, and a
  missing header on the same path as a wrong one.
- **`jwtAuthenticator<P>()({ jwks, issuer, audience, principal, scopes?, algorithms?, clockToleranceSec?, header? })`**, from
  `@btravstack/http-server/jwt`, with `jose` as an optional peer. JWKS fetch,
  cache and rotation; an asymmetric-only algorithm allowlist, because a JWKS
  publishes public keys and accepting `HS256` beside them is the
  algorithm-confusion attack; `iss`, `aud` and `exp` required to be present,
  `nbf` honoured when present.

The `/jwt` subpath needs Node ≥22.12 under CommonJS: `jose` is ESM-only, so the
CJS build's `require` depends on `require(esm)`. ESM consumers are unaffected.

Password hashing and credential issuing are out of scope — both of the above
are on the verifying side. Details:
[the reference page](https://btravstack.github.io/btravstack/reference/http-server).

## Options

`HttpModule(name)({...})` takes `http()`'s options plus `router`, `fragments`,
`fragmentsPrefix` and the module lists (`imports`, `provides`, `exports`,
`needs`) — supply `router`, `fragments`, or both; supplying neither is refused
at the call. Neither `http()` nor `htmx()` takes its answerer's provider as an
option — each **needs** its own port, which is how the composition root
supplies it:

| Option            | What it is                                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `router`          | the router provider — what `api.OrpcRouter(contract)(...)` returns                                                     |
| `fragments`       | the fragments provider — what `api.HtmxFragments([...])` returns over an array of `HtmxGet`/`HtmxPost` pieces          |
| `prefix`          | where the RPC endpoint is mounted (default `/rpc`)                                                                     |
| `fragmentsPrefix` | where htmx fragments are mounted (default `/`, `htmx()`'s own default)                                                 |
| `port`            | pins `PORT`                                                                                                            |
| `hostname`        | pins `HOST`                                                                                                            |
| `cors`            | pins `HTTP_CORS_ORIGIN` — `true` for oRPC's defaults, or its `CORSHandlerPluginOptions` (off); oRPC-only               |
| `bodyLimit`       | pins `HTTP_BODY_LIMIT` — the largest body a procedure or a fragment POST reads, in bytes (1 MiB; `false` is unbounded) |
| `compression`     | pins `HTTP_COMPRESSION` — response compression, `true` for oRPC's defaults or its options record; oRPC-only            |
| `plugins`         | any other oRPC handler plugin, forwarded to `RPCHandler`                                                               |
| `securityHeaders` | response headers set on the raw listener, before dispatch (default on)                                                 |

`cors`, `bodyLimit` and `compression` **pin** a field of `HttpConfig` that is
otherwise bound from the environment — explicit beats environment beats
default, per field — so a deployment sets `HTTP_CORS_ORIGIN` or
`HTTP_BODY_LIMIT` without a code change, and a test pins them instead. The rest
stay composition-time: `prefix` because a client's `baseURL` has to agree with
it, `securityHeaders` because a deployment that can silently turn
`x-frame-options` off is a footgun, and `plugins` (or a `CORSHandlerPluginOptions`
record) because an environment carries no records.

The full table — required/optional, defaults, and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/http-server),
which is this list's one detailed home.

## What it guarantees

Every request produces exactly one completed response, and its unit stays open
until that response is on the wire — the kernel's least-checkable contract,
made structural. A procedure's output or the `ORPCError` its `Result` was
mapped to is oRPC's; a defect inside a procedure is oRPC's own
`INTERNAL_SERVER_ERROR` collapse; an unmatched path is the package's `404`.
`Result` → HTTP status is the router's `.result()` triage — this package maps
nothing. The drain retires busy keep-alive connections and resets open
server-sent-event streams, so a client reconnects to a replica that is
staying rather than being reported abandoned; a client's `x-request-id`
becomes the unit's `traceId`. The rest is on the
[documentation site](https://btravstack.github.io/btravstack/reference/http-server).

## Streaming

A procedure whose output is an `eventIterator` is served as
`text/event-stream`, and `GET` is admitted for exactly those procedures — the
one request a browser's `EventSource` can send — so a stream is reachable
from a browser and from a typed oRPC client alike. A deploy resets an open
stream at the start of the drain, and the client resumes from
`Last-Event-ID`. The recipe is
[Stream with server-sent events](https://btravstack.github.io/btravstack/how-to/stream-with-server-sent-events).

## What it does not do

Each of these is a decision with a reason, and the reasons are on
[the reference page](https://btravstack.github.io/btravstack/reference/http-server#deliberately-not-included):

- **Another router inside the oRPC answerer** — a second protocol is a second
  answerer on the `HttpHandler` set port, under the same runtime.
- **A middleware slot for application logic** — oRPC's own middleware is where
  that belongs, and the ordinary cross-cutting concerns are named options.
  `plugins` is the honest escape hatch.
- **`Result` → HTTP status** — the router's `.result()` triage owns it.
- **Rate limiting** — a per-process counter is the wrong unit when a deployment
  is N pods; the ingress counts a request once.
- **Resource-dependent authorization** — a scope is checked here because it is
  a property of the credential; "is this caller the order's owner" needs the
  order, so it stays in the handler.
- **AND within one requirement**, **OpenAPI scheme metadata**, **HTTPS and
  HTTP/2** — a composite scheme, the contract, and the ingress, respectively.

## License

[MIT](./LICENSE) © Benoit TRAVERS
