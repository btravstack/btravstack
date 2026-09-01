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
  @btravstack/contract unthrown @orpc/server @orpc/contract @unthrown/orpc
```

All of those are peer dependencies — install every one, so the application
holds a single copy of each. Node `>=22`.

## A worked example

<!-- doctest: isolate
import { oc, type } from "@orpc/contract";
import { Port, type Module } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
import {
  DuplicateOrder,
  InvalidOrderId,
  InvalidQuantity,
  OrderNotFound,
  type Order,
} from "@btravstack/example-order-domain";
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

`api.OrpcRouter(contract)({ inject: deps, sync })` is right for a small API; a large
one splits into **pieces**, each owning one node of the contract tree, named
by a dotted path, composed at the root as an array instead — the same shape
`AmqpHandlers(contract)([...])` and `TemporalActivities(contract)([...])`
already have:

<!-- doctest: isolate
import { oc, type } from "@orpc/contract";
import { Port, type Module } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
import {
  DuplicateOrder,
  InvalidOrderId,
  InvalidQuantity,
  OrderNotFound,
  type Order,
} from "@btravstack/example-order-domain";
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
import { OkAsync, P } from "unthrown";
import { defineHttp } from "@btravstack/http-server";
const api = defineHttp();
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
const customersContract = {
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<{ readonly name: string }>()),
};
const orderContract = { orders: ordersContract, customers: customersContract };
const customersController = api.OrpcController(
  orderContract,
  "customers",
)({ inject: {}, sync: () => ({ find: () => OkAsync({ name: "Ada" }) }) });
declare const Application: Module<PlaceOrder | FindOrder, never, never>;
-->

```ts
const ordersController = api.OrpcController(
  orderContract,
  "orders",
)({
  inject: { place: PlaceOrder, find: FindOrder },
  sync: ({ place, find }) => ({
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

const orderRouter = api.OrpcRouter(orderContract)([
  ordersController,
  customersController,
]);
```

`api.OrpcController(contract, key)({ inject: { name: Dep }, sync })` — or just
`({ sync })` when the slice calls nothing — is the same two-call shape as
`api.OrpcRouter`, aimed at one node of the contract tree: the key is a
**dotted path** (`"orders"`, `"v1.orders"`), the path IS the port's name, so
there is nothing to name, and the provider carries the minted port on
`.port`. The array is **exact** — a path the contract does not declare is
refused at the mint, and the paths must partition the contract's procedures:
an uncovered procedure and a piece nested inside another piece's fragment are
each refused at the root — and because a fragment is itself a valid contract,
a slice can be served alone, its piece unchanged: the lifted root is
`api.OrpcRouter(orderContract.orders)({ inject: { implementation: ordersController.port }, sync: ({ implementation }) => implementation })`,
declaring the very provider the modulith composed. See
[Split a router into controllers](https://btravstack.github.io/btravstack/how-to/split-a-router-into-controllers).

A nested contract slices at any depth — a versioned API keeps its tree and
still gets a piece per team:

<!-- doctest: isolate
import { defineHttp } from "@btravstack/http-server";
import { oc } from "@orpc/contract";
import { OkAsync } from "unthrown";
const api = defineHttp();
-->

```ts
const contract = {
  v1: { orders: { place: oc }, customers: { find: oc } },
  health: oc,
};

const v1Orders = api.OrpcController(
  contract,
  "v1.orders",
)({ inject: {}, sync: () => ({ place: () => OkAsync("placed") }) });
const v1Customers = api.OrpcController(
  contract,
  "v1.customers",
)({ inject: {}, sync: () => ({ find: () => OkAsync("found") }) });
const health = api.OrpcController(
  contract,
  "health",
)({ inject: {}, sync: () => () => OkAsync("ok") });

const versionedRouter = api.OrpcRouter(contract)([
  v1Orders,
  v1Customers,
  health,
]);
```

## Protecting a procedure

A contract says which **security schemes** a procedure accepts and which scopes
each must grant. The marker is `@btravstack/contract`'s, so it lives in the
artifact a client holds too — and it names no identity type, so nothing about
the server's view of a caller reaches a client.

`defineHttp({ authenticators })` is what says **what each scheme resolves to**.
Declaring a scheme and implementing it are the same act, so there is no
registry to keep in step with the contract and nothing for a composition root
to forget:

**`src/auth.ts`** — the one file that names this deployment's identities

<!-- doctest: isolate
import { HttpAuthenticator, Unauthenticated, defineHttp, granted } from "@btravstack/http-server";
import { ErrAsync, OkAsync } from "unthrown";
-->

```ts
import {
  HttpAuthenticator,
  Unauthenticated,
  defineHttp,
  granted,
} from "@btravstack/http-server";
import { ErrAsync, OkAsync } from "unthrown";

export type Identity = { readonly tenantId: string; readonly userId: string };
export type ServiceIdentity = { readonly appId: string };

// An ordinary di provider description: `inject` is di's, so a JWT verifier or a
// user directory is injected the way any provider's are — an authenticator
// reading only headers declares none. The scope vocabulary is the second type
// argument, so the granted list is checked here rather than compared as loose
// strings at the endpoint.
const userAuth = HttpAuthenticator<Identity, "orders:export">()({
  inject: {},
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const [tenantId, userId, ...rest] = token.split(":");
    // Empty is not absent: `Authorization: :` splits into two defined strings,
    // and admitting them is admitting an anonymous caller as tenant "".
    return tenantId === undefined ||
      tenantId === "" ||
      userId === undefined ||
      userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync(
          // `granted()` is mandatory, not advisory: the brand it stamps is the
          // only sound way the starter tells a scoped answer from an identity
          // that merely carries a `scopes` field.
          granted(
            { tenantId, userId },
            rest
              .join(":")
              .split(",")
              .filter(
                (scope): scope is "orders:export" => scope === "orders:export",
              ),
          ),
        );
  },
});

const serviceAuth = HttpAuthenticator<ServiceIdentity>()({
  inject: {},
  sync: () => (headers) => {
    const key = headers["x-api-key"];
    return typeof key === "string" && key !== ""
      ? OkAsync({ appId: key })
      : ErrAsync(new Unauthenticated());
  },
});

// The scheme NAMES are the keys here, written once. Held whole and never
// destructured: each destructured member expands to a type mentioning the
// marker's inaccessible `unique symbol` (TS2527), while held whole it collapses
// to `Http<A>` — which is why this file writes no type annotation at all.
export const api = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth },
});
```

<!-- doctest: isolate
import { oc, type } from "@orpc/contract";
import { Port, type Module } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
import {
  DuplicateOrder,
  InvalidOrderId,
  InvalidQuantity,
  OrderNotFound,
  type Order,
} from "@btravstack/example-order-domain";
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
import { OkAsync, P } from "unthrown";
import { HttpModule } from "@btravstack/http-server";
import { api } from "../../auth.js";
class FindOrder extends Port("FindOrder")<{
  readonly execute: (tenantId: string, id: string) => AsyncResult<Order, OrderNotFound>;
}> {}
declare const Application: Module<FindOrder, never, never>;
-->

```ts
import { authenticated } from "@btravstack/contract";
import { HttpModule } from "@btravstack/http-server";
import { oc, type } from "@orpc/contract";
import { OkAsync, P } from "unthrown";

import { api } from "./auth.js";

const ordersContract = authenticated({ user: [] })({
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),

  // Overrides the group default for itself — nearest mark wins. Requirements
  // are ORed in declaration order: a `user` token granting `orders:export`, or
  // a `service` key with no scopes at all.
  export: authenticated(
    { user: ["orders:export"] },
    { service: [] },
  )(oc.output(type<{ readonly csv: string }>())),
});

const ordersRouter = api.OrpcRouter({ orders: ordersContract })({
  inject: { find: FindOrder },
  sync: ({ find }) => ({
    orders: {
      // One scheme, so the principal is the identity BARE.
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
      // Two schemes, so it is a discriminated union — and the switch is
      // exhaustive or the build fails.
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            return OkAsync({
              csv: `user,${context.principal.identity.userId}`,
            });
          case "service":
            return OkAsync({
              csv: `service,${context.principal.identity.appId}`,
            });
        }
      },
    },
  }),
});

// No authenticator to list: they ride the router, which is what needs them,
// and `HttpModule` puts them in `provides` itself.
const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [Application, Persistence],
});
```

Every slice mints its controller from that one `api`, and its handlers see the
right principal on `context.principal` with no annotation of their own. It is
the **only** way to read one: a marked fragment reached through anything else
types `principal: never` and every read is a compile error — the signal to use
the factory. An unmarked procedure still gets no principal at all: the contract
decides _which schemes_, the factory decides _what each one is_.

A router declares **one dependency per scheme its contract names**, so a scheme
with no authenticator behind it is an ordinary unmet need `start` refuses,
naming the port (`HttpAuthenticator:user`). There is no identity pair left to
compare: the registry that types the handlers and the providers that discharge
those ports come from the same call.

Before dispatch, the requirements are tried in the order the contract declared
them and the first a caller satisfies wins. A caller no requirement accepts
gets **`401`**; a caller whose credential was valid but lacked a required scope
gets **`403`**. Neither carries a message — oRPC serializes `message` to the
client, and a refusal has nothing a caller is entitled to, so an authenticator
that wants to record why logs it before returning `Unauthenticated`. A
**defect** from an authenticator is a bug, not a refusal: it stops the walk
rather than promoting the caller to the next scheme. See
[Protect a procedure](https://btravstack.github.io/btravstack/how-to/protect-a-procedure).

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
nothing. The drain retires busy keep-alive connections; a client's
`x-request-id` becomes the unit's `traceId`. The rest is on the
[documentation site](https://btravstack.github.io/btravstack/reference/http-server).

## What it does not do

- **Another router in oRPC's answerer.** oRPC through `@orpc/server/node`'s
  `RPCHandler` is how the oRPC answerer serves HTTP, and there is no `handler`
  option to swap it. htmx fragments are a **second** answerer contributing to
  the `HttpHandler` set port under the same runtime, not a different router in
  this one; GraphQL is next.
- **A middleware slot for application logic.** oRPC's own middleware, inside
  the router's procedures, is where that belongs. The one the package installs
  itself is `principalMiddleware`, on a leaf whose requirements say so. `plugins` is an
  honest escape hatch rather than a keyhole — an oRPC plugin's `init`
  transforms handler options **including interceptors**, so an application
  determined to see a procedure's outcome can get there. What the options buy
  is that the ordinary path — CORS, body limits, compression — is `cors`,
  `bodyLimit` and `compression`, configuration a reader can see at the
  composition root. CSRF is the one of the four still reached through
  `plugins`: it is only meaningful once a request carries a cookie, and this
  package has no cookie surface to configure it against. An application
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
- **Resource-dependent authorization.** "May this caller do this?" usually
  depends on the resource — the order's owner, its state, the row's tenant —
  which cannot be answered before the handler has run and fetched it. A
  **scope** is the exception, and on the same test: it is a property of the
  credential, answerable before dispatch, so the contract declares it and this
  package enforces it. Anything the handler has to fetch first stays the
  handler's.
- **AND within one requirement.** A requirement names one scheme. Requiring two
  credentials at once would put a record rather than an identity on the
  handler; a composite scheme models it where it is genuinely needed.
- **OpenAPI document metadata.** The schemes' own definitions — `type: http`,
  `bearerFormat`, an OAuth flow — belong beside the contract, not in this
  factory.
- **HTTPS, HTTP/2.** `node:http` only; terminate TLS at the ingress.

## License

[MIT](./LICENSE) © Benoit TRAVERS
