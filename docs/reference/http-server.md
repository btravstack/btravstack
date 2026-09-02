---
title: "@btravstack/http-server"
description: The HTTP starter — defineHttp, HttpModule, OrpcRouter, OrpcController, HtmxGet, HtmxPost, HtmxFragments, html and raw, HttpAuthenticator, http(), htmx(), HttpRuntime, HttpConfig and HttpInfo, named security schemes and scopes, cors, bodyLimit, compression, plugins and securityHeaders, what each request is answered with, and how the drain retires a keep-alive connection.
---

<!-- doctest: prelude
import { Logger } from "@btravstack/core";
import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { FindOrder, ListOrders, OrderApplicationModule, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";

import type { Order } from "@btravstack/example-order-domain";
import { Module } from "@btravstack/di";
import { HttpAuthenticator, Unauthenticated, defineHttp } from "@btravstack/http-server";
import { ErrAsync, OkAsync, P } from "unthrown";
import { customersController } from "../../slices/customers/controller.js";
import { ordersController } from "../../slices/orders/controller.js";
declare const view: (order: Order) => OrderView;
-->

# @btravstack/http-server

> **Reference.** A complete, structured description of the HTTP starter's
> public surface: every export of `@btravstack/http-server`, its options and their
> defaults, and what the package decides about a request. For the task, see
> [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http); for the
> reasoning behind a starter, see [Starters](/explanation/starters) and
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing); for the
> worked example, [Order API](/examples/order-api). Generated signatures are
> under [API reference](/api/http-server/).

## Exports

`packages/http-server/src/index.ts` exports exactly this:

| Export                 | Kind  | What it is                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineHttp`           | value | `defineHttp({ authenticators })`, or `defineHttp()` for a public API — **the one door**: it declares this deployment's security schemes and hands back `OrpcController`, `OrpcRouter` and `authenticators` typed by them                                                                                     |
| `Http`                 | type  | `Http<A>` — what `defineHttp` returns, held as one binding and never destructured                                                                                                                                                                                                                            |
| `Authenticators`       | type  | `Readonly<Record<string, Authenticator<…>>>` — the registry `defineHttp` takes, keyed by scheme name                                                                                                                                                                                                         |
| `SchemesFrom`          | type  | `SchemesFrom<A>` — the scheme-name → identity map read off the authenticators, so it is never declared twice                                                                                                                                                                                                 |
| `HttpModule`           | value | `HttpModule(name)({ router, prefix?, port?, hostname?, cors?, bodyLimit?, compression?, plugins?, securityHeaders?, imports?, provides?, exports?, needs? })` — a di `Module(name)({...})` that also takes the router provider; the composition root of an HTTP deployment                                   |
| `HttpModuleOptions`    | type  | The options object `HttpModule(name)` takes                                                                                                                                                                                                                                                                  |
| `HttpAuthenticator`    | value | `HttpAuthenticator<P, Scope>()({ inject: { name: Dep }, sync })`, or `({ inject: {}, sync })` with no deps — how one scheme is implemented; the scheme's **name** is the key it sits under in `defineHttp`                                                                                                   |
| `Authenticator`        | type  | what `HttpAuthenticator` hands back — a description carrying its deps, principal, scopes and needs, which `defineHttp` binds to a port                                                                                                                                                                       |
| `granted`              | value | `granted(identity, scopes)` — mints the scoped answer, stamped with a module-private symbol so the starter can tell it from a bare identity that carries a `scopes` field                                                                                                                                    |
| `Granted`              | type  | `Granted<P, Scope>` — the identity **bare** when the scheme has no scope vocabulary, a `Grant<P, Scope>` when it has one                                                                                                                                                                                     |
| `Grant`                | type  | `Grant<P, Scope>` — the branded `{ identity, scopes }` `granted()` returns; unforgeable from outside the package                                                                                                                                                                                             |
| `AuthenticatorService` | type  | `(headers: IncomingHttpHeaders) => AsyncResult<Granted<P, Scope>, Unauthenticated>` — headers in, credential out                                                                                                                                                                                             |
| `authenticatorPort`    | value | `authenticatorPort(scheme)` — the di port whose id is `` `HttpAuthenticator:${scheme}` ``; a router declares one per scheme its contract names                                                                                                                                                               |
| `Unauthenticated`      | value | a `TaggedError` with an empty payload — the refusal itself; the starter surfaces no reason to the client                                                                                                                                                                                                     |
| `UnderScoped`          | value | `TaggedError("UnderScoped")` — a valid credential missing a declared scope, answered `403`                                                                                                                                                                                                                   |
| `resolvePrincipal`     | value | the protocol-neutral authentication walk, shared by every answerer                                                                                                                                                                                                                                           |
| `Principal`            | type  | `Principal<S, Schemes>` — what a leaf's handler reads: bare for one scheme, a tagged union for several, `never` for none                                                                                                                                                                                     |
| `SchemesOf`            | type  | `SchemesOf<R>` — the union of scheme names a `Requirements` tuple mentions                                                                                                                                                                                                                                   |
| `http`                 | value | `http({ prefix?, port?, hostname?, cors?, bodyLimit?, compression?, plugins?, securityHeaders? })` — the starter module itself, needing the router port; what `HttpModule` imports                                                                                                                           |
| `httpServer`           | value | `httpServer(options?)` — the socket half: runtime, config, and the empty answerer set. `http()` is this plus oRPC                                                                                                                                                                                            |
| `HttpOptions`          | type  | `http()`'s options                                                                                                                                                                                                                                                                                           |
| `HttpRuntime`          | value | `class HttpRuntime extends RuntimePort<Runtime<typeof HttpHandler, HttpInfo>> {}` — the runtime's port; what `http()` provides and the module `start` boots must export. It **resolves `HttpHandler`**, so the root must export that too                                                                     |
| `HttpHandler`          | value | `class HttpHandler extends Port.many("HttpHandler")<HttpAnswerer> {}` — the set port every protocol served in this process contributes one member to                                                                                                                                                         |
| `HttpAnswerer`         | type  | one protocol's answer to HTTP — a mount `prefix` and the `handle` the runtime routes to; see [several answerers](#httphandler-and-several-answerers)                                                                                                                                                         |
| `HttpConfig`           | value | `class HttpConfig extends Port("HttpConfig")<{ port: number; hostname: string; bodyLimit: number; corsOrigin: string; compression: boolean }> {}` — what the transport is bound and configured with, provided by `http()` from `PORT` / `HOST` / `HTTP_BODY_LIMIT` / `HTTP_CORS_ORIGIN` / `HTTP_COMPRESSION` |
| `HttpInfo`             | type  | `{ readonly port: number }` — what the runtime publishes on `Serving.info` once listening, read back through `RunningApp.runtimeInfo()`                                                                                                                                                                      |
| `html`                 | value | `` html`<tr>${value}</tr>` `` — a tagged template returning `Html`, escaping every interpolation by default                                                                                                                                                                                                  |
| `raw`                  | value | `raw(markup)` — the one way past `html`'s escaping, a visible act at the call site                                                                                                                                                                                                                           |
| `Html`                 | type  | `{ readonly [HTML]: true; readonly value: string }` — the output of `html`/`raw`, and nothing else                                                                                                                                                                                                           |
| `ParamsOf`             | type  | `ParamsOf<Path>` — the `:name` segments a path template names, e.g. `ParamsOf<"/orders/:id/row">` is `{ readonly id: string }`                                                                                                                                                                               |
| `HtmxFragmentsPort`    | value | `class HtmxFragmentsPort extends Port("HtmxFragments")<{ routes; authenticators }> {}` — every route composed into one port; what `htmx()` answers from                                                                                                                                                      |
| `FragmentAnswer`       | type  | what the composed port carries for one route — principal and input erased to `unknown`                                                                                                                                                                                                                       |
| `htmx`                 | value | `htmx({ prefix? })` — the second answerer, one `HttpHandler` member serving fragments, mounted under `prefix` (default `/`)                                                                                                                                                                                  |
| `HtmxOptions`          | type  | `htmx()`'s options                                                                                                                                                                                                                                                                                           |

`OrpcController`/`OrpcRouter` and `HtmxGet`/`HtmxPost`/`HtmxFragments` are
**not** top-level exports: all five come off `defineHttp`, because that is
where the scheme registry that types them is stated. A marked contract or a
marked route reached through anything else would type `principal: never`.

`OrpcRouterPort` (the starter's router port, `Port("OrpcRouter")`) and
`Implementation<C, Schemes>` (the record type `OrpcRouter`'s `sync` returns)
exist in `src/orpc.ts` but are **not** exported from the package entry point:
the first is reached as `provider.port` when a caller needs it, the second is
inferred at the call. `HttpHandler` used to be a third — an internal seam, on
the grounds that oRPC was the only way to answer HTTP here — and is exported
now, since a second protocol's package has to name the set port it contributes
to.

## `HttpModule(name)({...})`

Everything `Module(name)({...})` takes — `imports`, `provides`, `exports` —
plus the starter's own fields. Supply `router`, `fragments`, or both; supplying
**neither is refused at this call**, against a
`"SERVES NOTHING — supply a router, fragments, or both"` marker, rather than
booting a listener with nothing behind it. It appends
`httpServer({ port, hostname, cors, bodyLimit, compression, securityHeaders })`
to `imports`; when `router` is given it prepends `router` **and the scheme
authenticators it carries**, plus `orpc({ prefix, plugins, … })`, to
`provides`; when `fragments` is given it prepends `fragments` and its own
authenticators, plus `htmx({ prefix: fragmentsPrefix })`. A scheme both
provide is deduplicated by reference before it reaches `provides`. It prepends
`HttpRuntime` and `HttpHandler` to `exports`, and hands the augmented tuples to
di's own `Module(name)`, whose return type is the sugar's. The kernel and both
gates see a plain module.

| Option            | Required | Default                      | What it is                                                                                                                                                                              |
| ----------------- | -------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router`          | no\*     | —                            | the application's router **provider** — a `Provider<OrpcRouterPort, E, N>`, what `api.OrpcRouter(contract)({ inject, ...arm })` returns; a provider on any other port fails at the call |
| `fragments`       | no\*     | —                            | the application's fragments **provider** — what `api.HtmxFragments([...])` returns over an array of `HtmxGet`/`HtmxPost` pieces; likewise typed to its own port                         |
| `prefix`          | no       | `/rpc`                       | where the RPC endpoint is mounted; typed `` `/${string}` ``                                                                                                                             |
| `fragmentsPrefix` | no       | `/`                          | where htmx fragments are mounted — `htmx()`'s own default, a separate field because one cannot carry two mount points with two different defaults                                       |
| `port`            | no       | read from `PORT`             | pins the port instead of reading it                                                                                                                                                     |
| `hostname`        | no       | read from `HOST`             | pins the host instead of reading it                                                                                                                                                     |
| `cors`            | no       | read from `HTTP_CORS_ORIGIN` | pins the CORS policy — `true` for oRPC's defaults, or its options record; applies only when `router` is served                                                                          |
| `bodyLimit`       | no       | read from `HTTP_BODY_LIMIT`  | pins the largest request body a procedure or a fragment POST reads, in bytes; `false` is unbounded                                                                                      |
| `compression`     | no       | read from `HTTP_COMPRESSION` | pins response compression — `true` for oRPC's defaults, or its options record; applies only when `router` is served                                                                     |
| `plugins`         | no       | `[]`                         | any other oRPC handler plugin, forwarded to `RPCHandler`                                                                                                                                |
| `securityHeaders` | no       | `true`                       | response headers set on the raw listener, before dispatch — covers both answerers                                                                                                       |
| `imports`         | no       | `[]`                         | the application's modules                                                                                                                                                               |
| `provides`        | no       | `[]`                         | the application's own providers                                                                                                                                                         |
| `exports`         | no       | `[]`                         | the application's own exports; `HttpRuntime` and `HttpHandler` are added                                                                                                                |

\* at least one of `router`/`fragments` is required.

The worked composition root, from `examples/order-api/src/module.ts`:

<!-- doctest: isolate
import { Logger, Tracer, Meter } from "@btravstack/core";
import { cache } from "@btravstack/cache";
import { redisCache } from "@btravstack/cache/redis";
import { HttpModule } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { orderRouter, orderFragments } from "../../module.js";
import { CustomersSlice } from "../../slices/customers/module.js";
import { OrdersSlice } from "../../slices/orders/module.js";
-->

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  fragments: orderFragments,
  imports: [
    OrdersSlice,
    CustomersSlice,
    cache({ adapter: redisCache() }),
    observability(),
    otel(),
  ],
  exports: [Logger, Tracer, Meter],
});
```

That composes both answerers: the router under `/rpc`, the fragments under
`/` — `fragmentsPrefix`'s own default. **There is no `authenticator`
option**: the authenticators ride the router and the fragments provider —
which is what needs them — and the sugar spreads them into `provides` itself,
so an application never lists one and cannot list the wrong one. Their own
dependencies (a JWT verifier, a key set) travel with them, so a root that
satisfies none is refused at **this** call by di's `NeedsGate`, exactly as a
hand-listed provider would be. A root serving `router` alone drops
`fragments`; a fragments-only root drops `router`, and its `prefix`, `cors`,
`compression` and `plugins` options — oRPC-only — go unused.
[`observability()`](/reference/observability) is a second
starter, not this package's business: it brings the `Logger` the application
writes to, bound from `LOG_LEVEL`, JSON per line on stdout, every line
carrying the trace id of the unit this runtime opened.

### RED metrics, reported always and collected when you ask

The runtime REPORTS rate, errors and duration at the unit seam — the one place a
framework that owns the unit lifecycle gets them for free — and an observer is
what turns a report into a measurement. Reporting always happens; **collection
happens when `otel()` is composed**, and not before:

| Instrument                 | Kind           | Dimensions                     |
| -------------------------- | -------------- | ------------------------------ |
| `btravstack.http.requests` | counter        | `method`, `answerer`, `status` |
| `btravstack.http.duration` | histogram (ms) | the same three                 |

`instrumented` is gone. Every unit is handed to `Observers`, and this module
contributes a no-op member of its own — so a graph composing no observability
owes nothing, and an operation costs one inert call per module that reads the
port. Composing [`observability()`](/reference/observability) writes the
failures as lines; composing `otel()` beside it opens the spans and mints
`btravstack.<component>.operations` and `.duration`.

**The dimensions are chosen for cardinality, and what is absent matters more
than what is present.** The request **path** is not a dimension: `/orders/42` would mint a time series per order, which is the classic way a metrics bill becomes the incident. `answerer` is a mount prefix, so the graph bounds it. Recording happens on the response's `'close'`, which is the one event that has seen the final status — the runtime's own `404` and `500` included, which no answerer ever sees.

## `api.OrpcRouter(contract)({ inject: deps, sync })`

Contract-first: `contract` is an oRPC router record (`Record<string,
RouterContract>` — a record, not a bare procedure), and the second call is
di's `Provider(port)({ inject: deps, sync })` on the starter's own router port with one
difference — `sync` returns an **implementation record shaped like the
contract** and the router is built from it. Only the `sync` arm exists: a
router is built, not acquired.

Each leaf is the `.result()` handler `@unthrown/orpc` gives that procedure's
implementer: `(helpers, input) => AsyncResult<Output, ORPCError>`, where
`input` is the contract's parsed input, `Output` its declared output and
`helpers.errors` its declared error map. A typo'd key, a missing procedure or
a wrong output type is a compile error at the call. `implement(contract)`,
`os.…`, `.result(...)` and `os.router(...)` are what the call does for you.

There is no name to give: a process serves one router as it boots one
runtime, so the port is the starter's — `Port("OrpcRouter")`, declared once,
framework-owned like `HttpConfig` — and two router providers in one graph are
di's duplicate-provider defect at build. Returns
`Provider<PortInstance<"OrpcRouter", Router<…>>, never, InstanceType<D[keyof D]>> & { readonly port: PortClassOf<"OrpcRouter", Router<…>> }` —
`provider.port` is the port class, for a hand-declared provider or a type
test, and `provider.authenticators` carries the scheme providers `defineHttp`
bound. The implementation below is the one in
`examples/order-api/src/slices/orders/controller.ts`, served through the
deps form — the example composes it as a controller instead (see the
composing form), and a fragment is a contract, so the same `sync` reads either way.
`contract.orders` is marked `authenticated({ user: [] })`, so `api` here is the
application's own `defineHttp` binding, from its `src/auth.ts`, and the tenant
comes off `context.principal` rather than off the input:

<!-- doctest: defer -->

```ts
export const ordersRouter = api.OrpcRouter(contract.orders)({
  inject: { place: PlaceOrder, find: FindOrder, list: ListOrders },
  sync: ({ place, find, list }) => ({
    place: ({ errors, context }, input) =>
      place
        .execute(context.principal.tenantId, input.id, input.quantity)
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
    find: ({ errors, context }, input) =>
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
    // A listing. The one translation is the cursor — the contract carries
    // `after` and `before` and refuses both, where the port makes them a
    // union — and the only modeled failure is that cursor, the one field
    // that came from outside.
    list: ({ errors, context }, { after, before, ...page }) =>
      list
        .execute(
          context.principal.tenantId,
          before === undefined
            ? { ...page, ...(after === undefined ? {} : { after }) }
            : { ...page, before },
        )
        .map((found) => ({ ...found, items: found.items.map(view) }))
        .mapErrCases((matcher) =>
          matcher.with(P.tag("MalformedCursor"), (error) =>
            errors.BAD_REQUEST({
              message: "the cursor could not be read",
              data: { cursor: error.cursor },
            }),
          ),
        ),
    // `export` names two schemes, so its principal is a tagged union the
    // handler narrows — and the switch is exhaustive or the build fails.
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
  }),
});
```

An implementation key the contract does not declare is unreachable through
the types; if one is smuggled past them it is dropped, not defected on.

### The composing form: `api.OrpcRouter(contract)([piece, …])`

For a `contract` shaped `Record<string, RouterContract>`, `OrpcRouter`
also takes an **array of pieces** — each an
[`OrpcController(contract, path)`](#api-orpccontroller-contract-path) over one
node of the contract tree, at any depth — instead of `{ inject, sync }`:

<!-- doctest: defer -->

```ts
export const orderRouter = api.OrpcRouter(contract)([
  ordersController,
  customersController,
]);
```

Coverage is **leaf-based**: the pieces' paths must partition the contract's
**procedures**, so any mix of depths composes — a piece per top-level fragment,
one nested under `"v1.orders"`, or one at a bare procedure path like
`"health"`, side by side. An uncovered procedure is refused against the last
overload — declared last on purpose, so TypeScript reports its failure rather
than degrading to di's own `Qualification`, which names nothing:

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Minted<{ orders: { place: ContractBuilder<object>; }; customers: { find: ContractBuilder<object>; }; }, "orders", SchemesFrom<Record<never, never>>, never>' is not assignable to type '"UNCOVERED CONTROLLERS — the contract declares a procedure this array does not cover"'.
```

Read the **last** line: it is the only actionable part of the diagnostic. The
missing procedure itself is named only once the array's length matches the
marker tuple's own length of 2, as a **separate** diagnostic on the trailing
element:

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Minted<{ v1: { orders: { place: ContractBuilder<object>; }; customers: { find: ContractBuilder<object>; }; }; health: ContractBuilder<object>; }, "health", SchemesFrom<...>, never>' is not assignable to type '"v1.customers.find"'.
```

A **second** gate rides the same overload: two pieces whose paths **nest** —
`"v1"` and `"v1.orders"` — would implement the same procedures on two
**distinct** port ids, which di cannot see conflicting (unlike two pieces at
the same path, which share one id and are di's ordinary duplicate-provider
defect), so overlap is refused explicitly:

```text
error TS2769: No overload matches this call.
  The last overload gave the following error.
    Type 'Minted<{ v1: { orders: { place: ContractBuilder<object>; }; customers: { find: ContractBuilder<object>; }; }; health: ContractBuilder<object>; }, "v1", SchemesFrom<...>, never>' is not assignable to type '"OVERLAPPING CONTROLLERS — a piece sits inside another piece's fragment"'.
```

The requirements fold down every path exactly as
[`Implementation<C, Schemes>`](#authentication) folds them: a contract marked
at its **root** composes through this form too, and each piece inherits those
requirements down to whatever depth it is minted at — unless it carries a mark
of its own, in which case that one wins. Five compile-time gates are pinned by
`packages/http-server/src/controller.test-d.ts`: every procedure must be
covered (the marker above); a path the contract does not declare is refused
**at the mint**, not at the router (see
[`OrpcController`](#api-orpccontroller-contract-path) below); a piece under
the wrong path is impossible **by construction**, since the path rides the
piece's own port id — what that would have meant is now an array leaving a
procedure uncovered; a procedure a piece's own fragment does not declare is
rejected inside the piece, before the router ever sees it; and a slice lifts
into a process of its own with its piece untouched —
`api.OrpcRouter(contract.orders)({ inject: { implementation: ordersController.port }, sync: ({ implementation }) => implementation })`
compiles — the property a slice's independent deployability rests on. The
`{ inject, sync }` form is unchanged and stays correct for a small API — an
array is never a valid `{ inject, ...arm }` call, so `Array.isArray` alone
tells the two arms apart, and there is nothing else left to discriminate. See
[Split a router into controllers](/how-to/split-a-router-into-controllers) for
the worked recipe.

## `api.OrpcController(contract, path)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
const OrpcController: <
  const C extends Record<string, RouterContract>,
  const K extends ControllerKeyOf<C>,
>(
  contract: C,
  path: K,
) => <const D extends Readonly<Record<string, AnyPort>>>(options: {
  readonly inject: D;
  readonly sync: (services: {
    readonly [N in keyof D]: ServiceOf<InstanceType<D[N]>>;
  }) => Implementation<FragmentAt<C, K>, Schemes>;
}) => Provider<
  PortInstance<
    `OrpcController:${K}`,
    Implementation<FragmentAt<C, K>, Schemes>
  >,
  never,
  InstanceType<D[keyof D]>
> & {
  readonly port: PortClassOf<
    `OrpcController:${K}`,
    Implementation<FragmentAt<C, K>, Schemes>
  >;
};
```

One node of a contract, at any depth, as a provider over a port minted for
it — the same two-call shape as
`api.OrpcRouter(contract)({ inject: { name: Dep }, sync })`, aimed at one `path` into
`contract` rather than the whole tree: a top-level fragment (`"orders"`), a
nested one (`"v1.orders"`), or a bare procedure (`"health"`). `contract` is
read for its **type** only: `path` is checked against `ControllerKeyOf<C>` —
every path into the contract tree — so a path the contract does not declare is
refused **at this call**, with nothing to type the key by:

```text
error TS2345: Argument of type '"billing"' is not assignable to parameter of type '"customers" | "customers.find" | "orders" | "orders.place"'.
```

`path` also shapes `sync`'s return through `FragmentAt<C, K>`, so a procedure
the node does not declare, or a handler whose input or output has drifted, is
a compile error inside the piece. There is no name to give: the path **is**
the port's name, minted as `` `OrpcController:${path}` `` — the same move
`AmqpHandler(contract, key)` makes — and carried back on `provider.port`, the
shape `Config.provider("RelayConfig")(schema)` already uses, so a slice's
module exports `controller.port` rather than naming a port of its own:

<!-- doctest: defer -->

```ts
export const OrdersSlice = Module("OrdersSlice")({
  needs: [Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [ordersController],
  exports: [ordersController],
});
```

`Schemes` is fixed by the `defineHttp` call the piece was minted from, which is
what gives a marked fragment's handlers a readable `context.principal`. The
piece does no oRPC work: it is a plain record, and `OrpcRouter`'s own walk
wraps each leaf in `.result(...)` when the composing form builds the router.
**A fragment is itself a valid contract**, so a slice lifts out into a
process of its own without its piece changing at all — the lifted root
declares the piece's own port and hands back what it built:

<!-- doctest: isolate
import { contract } from "@btravstack/example-order-api-contract";
import { api } from "../../auth.js";
import { ordersController } from "../../slices/orders/controller.js";
-->

```ts
export const ordersRouter = api.OrpcRouter(contract.orders)({
  inject: { implementation: ordersController.port },
  sync: ({ implementation }) => implementation,
});
```

That property is marked do-not-break: it is what makes composing several
slices into one router a starting point rather than a trap.

## Authentication

A contract marked with [`@btravstack/contract`](/reference/contract)'s
`authenticated(...requirements)` is what turns this on. Nothing here is a
switch on the starter: the marker is a fact about the contract, and both halves
of the package follow it.

A **requirement** is OpenAPI's own shape — a security scheme's name mapped to
the scopes it must grant. Several requirements on one mark are **ORed**, tried
in declaration order. A marked record is the default for every procedure
beneath it; a procedure's own mark **replaces** that default for itself.
Nearest mark wins.

**In the types.** `Implementation<C, Schemes>` branches on the marker. A
marked **leaf** gets `{ readonly principal: Principal<SchemesOf<R>, Schemes> }`
in its implementer's
injected context, so the handler reads `opts.context.principal` — oRPC's own
context channel, not a second handler parameter this package invents and not a
wrapper around `.result()`. An unmarked
leaf's context is unchanged, which is what makes reading a principal there a
compile error.

**At runtime.** `OrpcRouter`'s walk carries the effective requirements down the
contract exactly as the types do, and a protected leaf is built as
`node.use(principalMiddleware(requirements, authenticators)).result(fn)` —
`.use` before `.result`, which is the only order oRPC leaves available. The
middleware reads the request off oRPC's initial context and tries the
requirements in order, calling each scheme's authenticator with the request's
headers, until one is satisfied.

### `Principal` — what a handler actually reads

| The leaf's requirements name | `context.principal`                           |
| ---------------------------- | --------------------------------------------- |
| one scheme                   | that scheme's identity, **bare**              |
| several schemes              | `{ scheme, identity }`, a discriminated union |
| none (unmarked)              | absent — reading it is a compile error        |

The one-scheme case is byte-for-byte what a handler wrote before named schemes
existed, so the common case pays nothing for the feature. The multi-scheme case
is narrowed with a `switch` whose missing arm leaves a path returning nothing,
which the handler's own return type refuses:

<!-- doctest: skip — an excerpt of the handler shown in full in the fence above -->

```ts
export: ({ context }) => {
  switch (context.principal.scheme) {
    case "user":
      return OkAsync({ csv: `user,${context.principal.identity.userId}` });
    case "service":
      return OkAsync({ csv: `service,${context.principal.identity.appId}` });
  }
};
```

### `HttpAuthenticator<P, Scope>()({ inject: { name: Dep }, sync })`

How **one scheme** is implemented. It hands back a description `defineHttp`
binds to that scheme's port; the scheme's **name** is not stated here, because
it is the key the authenticator sits under in `defineHttp({ authenticators })`
— written once.

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Grant<P, Scope extends string> = {
  readonly identity: P;
  readonly scopes: readonly Scope[];
  readonly [GRANT]: true; // a module-private symbol; `granted()` is what stamps it
};

type Granted<P, Scope extends string> = [Scope] extends [never]
  ? P
  : Grant<P, Scope>;

const granted: <P, const Scope extends string = never>(
  identity: P,
  scopes: readonly Scope[],
) => Grant<P, Scope>;

type AuthenticatorService<P, Scope extends string = never> = (
  headers: IncomingHttpHeaders,
) => AsyncResult<Granted<P, Scope>, Unauthenticated>;
```

**Headers, not the request**: an authenticator has no business reading a body,
and the narrower argument is what keeps it testable without a socket. `deps`
are di's, so a JWT verifier or a user directory is injected the way any
provider's dependencies are, and that need travels with the authenticator into
the graph. Both type arguments are **explicit** rather than
inferred from `sync` — inference through a returned function's `AsyncResult` is
where a principal silently widens to `unknown`.

A scheme with **no scope vocabulary** returns the identity bare. One **with**
a vocabulary reports what the credential actually granted through
**`granted(identity, scopes)`**, checked against the declared vocabulary at the
authenticator rather than compared as loose strings at the endpoint. The helper
is **mandatory, not advisory**: the type parameter is erased at runtime, so the
brand it stamps is the only sound way the starter can tell the scoped answer
from an identity that merely happens to carry a `scopes` field — an ordinary
JWT-claims shape, which a structural test read as the scoped answer and handed
the handler `undefined`.

```ts
import { TenantId } from "@btravstack/example-order-domain";
import { granted } from "@btravstack/http-server";

export const userAuth = HttpAuthenticator<Identity, "orders:export">()({
  inject: {},
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const [tenantId, userId, ...rest] = token.split(":");
    // Rejoined rather than taken as one field: a scope name contains the
    // delimiter itself, so `orders:export` cannot survive a plain third field.
    const claimed = rest.join(":");
    return tenantId === undefined ||
      tenantId === "" ||
      userId === undefined ||
      userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync(
          granted(
            { tenantId: TenantId(tenantId), userId },
            claimed
              .split(",")
              .filter(
                (scope): scope is "orders:export" => scope === "orders:export",
              ),
          ),
        );
  },
});

// A second scheme: an API key, no scopes, no tenant.
export const serviceAuth = HttpAuthenticator<ServiceIdentity>()({
  inject: {},
  sync: () => (headers) => {
    const key = headers["x-api-key"];
    return typeof key === "string" && key !== ""
      ? OkAsync({ appId: key })
      : ErrAsync(new Unauthenticated());
  },
});
```

`Unauthenticated` is a `TaggedError` with an **empty payload**: the starter
surfaces no reason, so a field would be write-only. An authenticator that wants
to record why logs it before returning. Forwarding a reason would put "no such
user" versus "bad signature" in a 401 body by default.

### `defineHttp({ authenticators })` — what each scheme resolves to

**The contract says _which schemes_ protect a route; this says _what each one
is_.** The contract names no identity type at all, so nothing about the
server's view of a caller reaches a client — and this call is the only thing
that gives a marked handler a readable `context.principal`. Declaring a scheme
and implementing it are the **same act**, so a scheme without an authenticator
is not a state this can reach:

**`src/auth.ts`** — one per application

```ts
export type Identity = { readonly tenantId: TenantId; readonly userId: string };
export type ServiceIdentity = { readonly appId: string };

export const api = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth },
});
```

Every slice mints its controller from that one `api`, and its handlers see the
right principal with no annotation of their own; nothing else about a
controller changes.

::: warning Hold it whole — never destructure it
`const { OrpcController } = defineHttp(...)` is **TS2527**: each binding of a
destructured member expands to a type mentioning `@btravstack/contract`'s
inaccessible `unique symbol`, which the file cannot emit. Held whole, the
inferred type collapses to `Http<A>`, which is nameable — which is why the
file above writes **no type annotation at all**.
:::

`defineHttp()` with no argument is the public-API case: the registry is
`Record<never, never>`, so a contract that marks anything leaves a scheme port
unmet and the composition is refused. It is deliberately not
`Record<string, never>` — an index signature would make every scheme's port
look available, and the composition would type-check and then fail at build.

It is per application rather than per slice because a handler's parameter types
are fixed **where the arrow is written**: a composition root cannot re-type a
`sync` callback that lives in another module, so the registry has to be in
scope where the handler is.

### The gate: one dependency per scheme

For every scheme its contract names anywhere, `OrpcRouter` adds that scheme's
port — `` `HttpAuthenticator:${scheme}` `` — to the router provider's deps
record under a **namespaced** key (so it cannot collide with one you wrote),
strips those keys back out before your own `sync` sees the record, and adds
them to the provider's needs channel. A scheme with no authenticator behind it
is therefore an ordinary unmet need at `start`, not a gate this package
invented, and the diagnostic **names the port**:

```text
Type '"HttpAuthenticator:user"' is not assignable to type '"@di/Scope"'
```

(Not di's `UNSATISFIED DEPENDENCIES` dependency gate: that one guards
`Module.build`/`Module.scoped`, and `start` types the need out on its parameter
instead.)

There is nothing left for a second gate to check. The registry that types the
handlers and the providers that discharge those ports come from the **same**
`defineHttp` call, so they cannot disagree — which is why the identity
comparison an earlier design performed at `HttpModule` is gone, along with the
`authenticator` option it lived on.

### `401` and `403`

Requirements are tried in the order the contract declared them, and the first
a caller satisfies wins.

| Outcome                                                         | Answer                                       |
| --------------------------------------------------------------- | -------------------------------------------- |
| a requirement is satisfied                                      | the handler runs, principal injected         |
| no requirement accepted the caller                              | **`401 UNAUTHORIZED`**                       |
| a credential was valid but lacked a scope the requirement named | **`403 FORBIDDEN`**                          |
| an authenticator returned a `Defect`                            | oRPC's `INTERNAL_SERVER_ERROR`, walk stopped |

Neither refusal carries a message: oRPC serializes `message` to the client, and
a refusal has nothing a caller is entitled to. A requirement naming scopes is
**not** satisfied by a credential reporting none — a scheme declared without a
vocabulary answers bare, and admitting it there would admit the caller
outright. An empty scope list still passes trivially. A `Defect` is a bug in
the authenticator rather than a refusal, so it short-circuits: falling through
would let a broken verifier silently promote every caller to the next scheme.

### The marker is legibility, not enforcement

An unmarked procedure is public, and **nothing fails if the marker is
forgotten** — no compile error, no startup failure. There is no
deny-by-default here; the contract makes a protected route visible to both
sides, and that is all it claims. See
[Protect a procedure](/how-to/protect-a-procedure).

## `html` and `raw`

A fragment's handler returns `Html`, not a string: `` html`…` `` escapes
every interpolation by default, and `raw(markup)` is the one way past it.

<!-- doctest: isolate
import { html } from "@btravstack/http-server";
declare const order: { readonly id: string; readonly quantity: number };
-->

```ts
html`<tr id="order-${order.id}"><td>${order.quantity}</td></tr>`;
```

A nested `Html` splices as it is — composition needs no `join` — and an array
of them concatenates with no separator, so a list of rows is as simple as
`` html`${rows}` `` over an array built with `.map`.

::: warning
The escaping is **context-blind**: it protects element text and a _quoted_
attribute value, and nothing else. An unquoted attribute, an attribute name, a
URL scheme (`href="${url}"` does not vet `javascript:`), and
`<script>`/`<style>` contents are the caller's own responsibility.
:::

oxfmt and prettier treat a tagged template named `html` as embeddable markup
and reflow it, inserting real whitespace into rendered output. This repo sets
`embeddedLanguageFormatting: "off"`; a consuming application needs the same
setting, or its rendered output drifts the moment a formatter runs.

## `api.HtmxGet(path, options?)` and `api.HtmxPost(path, options?)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type RouteHandler<Path extends string, Input, Principal> = (
  context: [Principal] extends [never] ? object : { readonly principal: Principal },
  params: ParamsOf<Path>,
  input: Input, // GET: Readonly<Record<string, string>>, `{}` at runtime; POST: the schema's output, or the raw decoded form when `options.input` is omitted
) => AsyncResult<Html, never>;
```

A route as a provider on a port of its own, minted straight from its method
and path — no contract in between, mirroring htmx's own `hx-get`/`hx-post`:

```ts
import { FindOrder } from "@btravstack/example-order-application";
import { html } from "@btravstack/http-server";
import { P } from "unthrown";

export const orderRowFragment = api.HtmxGet("/orders/:id/row", {
  requires: [{ user: [] }],
})({
  inject: { find: FindOrder },
  sync:
    ({ find }) =>
    (context, params) =>
      find
        .execute(context.principal.tenantId, params.id)
        .map(
          (order) =>
            html`<tr id="order-${order.id}">
              <td>${order.quantity}</td>
            </tr>`,
        )
        .recoverErrCases((matcher) =>
          matcher.with(
            P.tag("OrderNotFound"),
            () =>
              html`<tr>
                <td>not found</td>
              </tr>`,
          ),
        ),
});
```

`options.requires` marks the route exactly as `authenticated(...)` marks an
oRPC procedure — the same `resolvePrincipal` walk runs, so a route gets the
same `401`/`403` path and the same `Principal<S, Schemes>` typing on
`context.principal`. Omit it and the route is public, with no `principal` on
`context` at all — reading one is a compile error. A scope the scheme's own
authenticator never grants fails the compile ending on
`"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"`, naming
the scope.

Only `HtmxPost`'s `options` carry an `input` field — `HtmxGet`'s options type
has none, so passing one is a compile error naming the unknown property
rather than a value refused at the call: unexpressible, not merely refused.
`input` is any Standard Schema over the decoded form body — the same shape
[`Config.provider`](/reference/config) accepts. `ParamsOf<Path>` extracts the
`:name` segments a path template names, at the type level:
`ParamsOf<"/orders/:id/row">` is `{ readonly id: string }`, and a template
naming none is an empty record.

The route's key is `` `${method} ${path}` ``, minted as the port id
`` `HtmxFragment:GET /orders/:id/row` `` — the same two-call shape as
[`api.OrpcController(contract, path)`](#api-orpccontroller-contract-path),
with the path standing in for a contract key. The key space is **flat**, so
two routes minted for one method and path are simply di's duplicate-provider
defect, via the port id each carries — there is no unsliceable or
overlapping path to refuse. See
[Serve htmx fragments](/how-to/serve-htmx-fragments) for the worked recipe.

## `api.HtmxFragments([piece, …])`

Every route composed from an array of `HtmxGet`/`HtmxPost` pieces, mirroring
[the composing form](#the-composing-form-api-orpcrouter-contract-piece) of
`OrpcRouter` minus the coverage it checks — there is no declared route set to
leave uncovered:

```ts
export const orderFragments = api.HtmxFragments([orderRowFragment]);
```

Routes are matched in this array's own **order**, first match wins — see
[Serve htmx fragments](/how-to/serve-htmx-fragments#step-2-—-compose-the-pieces)
for why that ordering is a security property, not only a routing one. The
returned provider carries `readonly authenticators` the same way the router
does, so `HttpModule` can deduplicate a scheme the two share, by reference.

## `http(options)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
const http: (
  options?: HttpOptions,
) => Module<HttpRuntime | HttpConfig | HttpHandler, ConfigInvalid, Env | OrpcRouterPort>;
```

The primitive `HttpModule` delegates to, for a composition root written by
hand. `HttpOptions`:

| Option            | Required | Default            | What it is                                                      |
| ----------------- | -------- | ------------------ | --------------------------------------------------------------- |
| `prefix`          | no       | `/rpc`             | where the RPC endpoint is mounted                               |
| `port`            | no       | read from `PORT`   | pins the port                                                   |
| `hostname`        | no       | read from `HOST`   | pins the host                                                   |
| `cors`            | no       | `HTTP_CORS_ORIGIN` | `boolean \| CORSHandlerPluginOptions`, oRPC's CORS plugin       |
| `bodyLimit`       | no       | `HTTP_BODY_LIMIT`  | `number \| false`, the largest body a procedure reads, in bytes |
| `compression`     | no       | `HTTP_COMPRESSION` | `boolean \| ResponseCompressionHandlerPluginOptions`            |
| `plugins`         | no       | `[]`               | `NodeHttpHandlerPlugin[]`, forwarded to oRPC's own `RPCHandler` |
| `securityHeaders` | no       | `true`             | `boolean \| Record<string, string>`, applied on the listener    |

The module **provides** `HttpRuntime` and `HttpConfig`, exports both, and
**needs** `Env` (the kernel discharges it) and the starter's router port
(`OrpcRouterPort`, the port `api.OrpcRouter(contract)({ inject, ...arm })` provides on) —
the runtime provider depends on the router through di, which is why a
composition that imports `http()` without providing the router carries an
unmet need `start` refuses (di's gate, not the kernel's). The router is not an
option: there is no other port it could be on. The
declared type is the same whether or not a field is pinned: `Env` and
`ConfigInvalid` stay in the signature, and a pinned config never produces the
latter.

### `cors`, `bodyLimit`, `compression`

`boolean | CORSHandlerPluginOptions`, `number | false` and
`boolean | ResponseCompressionHandlerPluginOptions` — three oRPC plugins as
**named options**, so the ordinary transport policy is configuration a reader
sees at the composition root:

<!-- doctest: isolate
import { HttpModule } from "@btravstack/http-server";
import { orderRouter } from "../../module.js";
import { CustomersSlice } from "../../slices/customers/module.js";
import { OrdersSlice } from "../../slices/orders/module.js";
-->

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice],
  cors: { origin: "https://orders.example", credentials: true },
  bodyLimit: 5_000_000,
  compression: true,
});
```

`true` takes the underlying plugin's own defaults; a record is that plugin's
own options type verbatim, never a `Record<string, unknown>` bag.

**The scalar half of each is a field of
[`HttpConfig`](#httpconfig-and-the-environment), and the
option pins it** — exactly as `port` pins `PORT`:

| Variable           | Default     | What it is                                                             |
| ------------------ | ----------- | ---------------------------------------------------------------------- |
| `HTTP_BODY_LIMIT`  | `1048576`   | the largest request body a procedure reads, in bytes; `0` is unbounded |
| `HTTP_CORS_ORIGIN` | unset (off) | comma-separated allowed origins, or `*`                                |
| `HTTP_COMPRESSION` | `false`     | a flag — `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`               |

So a deployment admits a browser client by setting `HTTP_CORS_ORIGIN`, with no code
change; a test pins `cors` instead. Explicit beats environment beats default,
per field: a `CORSHandlerPluginOptions` record naming `origin` wins over
`HTTP_CORS_ORIGIN`, which wins over oRPC's own default of reflecting the request's
origin, and `cors: false` is off whatever the environment says.

The **shapes** stay composition-time — a record's allowed methods and headers,
compression's `encodings` and `threshold`, `plugins` itself — because an
environment carries no records. `securityHeaders` stays composition-time too,
and deliberately: a deployment that can silently turn `x-frame-options` off is
a footgun the other three are not.

**`bodyLimit` defaults to 1 MiB because an unbounded body is a trust boundary
rather than a convenience.** `cors` and `compression` are policy — who may
call, and how the bytes travel — and a framework guessing either is worse than
one that stays quiet; a body nobody bounded is a request that can consume the
process. Over the limit is oRPC's `PAYLOAD_TOO_LARGE`, decided on
`content-length` when one is sent and while streaming otherwise. An application
serving uploads raises it, and `false` — like `BODY_LIMIT=0` — turns it off.

`compression` is the **response** half. Request decompression is a separate
oRPC plugin (`RequestCompressionHandlerPlugin`), left to `plugins` because
inflating a body before the limit measures it is a decision an application
should make in the open.

**CSRF is deliberately not an option here**, though this package's own spec
once claimed it: oRPC's protection is meaningful only once a request carries a
`SameSite` cookie, and this package configures no cookies. It stays reachable
through `plugins`, and becomes an option when cookies do.

### `plugins`

`readonly NodeHttpHandlerPlugin<DefaultInitialContext>[]`, from
`@orpc/server/node`, appended to the three configured above and forwarded
straight to `new RPCHandler(service, { plugins })` — any oRPC plugin the named
options do not cover, imported from `@orpc/server/plugins`:
`plugins: [new BatchHandlerPlugin()]`.

`plugins` is an **honest escape hatch, not a keyhole**. oRPC's
`StandardHandlerPlugin.init` transforms handler options — including
`StandardHandlerOptions.interceptors` — so a plugin can wrap execution, and an
application determined to see a procedure's outcome can get there. Nothing
pretends otherwise. What the option buys is that the ordinary path is
configuration a reader can see at the composition root, and reaching past it is
a visible act rather than the default shape; an application middleware acting on
the handler's `Result` is still what
[Deliberately not included](#deliberately-not-included) refuses. It threads
through all three surfaces (`http()`, `HttpModule` and the internal oRPC
options) as a plain optional field.

Note what a plugin does **not** cover: it only runs for a request oRPC
**matched**, so the runtime's own `404` and `500` never reach one. That is why
`securityHeaders` is not a plugin.

### `securityHeaders`

`boolean | Readonly<Record<string, string>>`, default `true`. Applied by the
package on the **raw node listener**, before dispatch — the first statement of
the request handler — so it covers a served response, the runtime's `404`, its
`500` and a drained response alike.

| Value                    | Effect                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `true` (default)         | `x-content-type-options: nosniff`, `x-frame-options: DENY`, `referrer-policy: no-referrer` |
| `false`                  | nothing is set                                                                             |
| `Record<string, string>` | replaces the defaults outright — the record is the whole set                               |

The set is resolved once per `listen`, not per request. It is deliberately
small: a default that has to be right for every deployment cannot include a
CSP, an HSTS max-age or a permissions policy, all of which are a deployment's
own decision — pass a record when you have made those.

## `htmx(options)`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
const htmx: (options?: HtmxOptions) => Provider<HttpHandler, never, HtmxFragmentsPort | HttpConfig>;
```

The second answerer: fragments, mounted under `prefix` (default `/`). It
matches a request against the composed fragments' routes by method and path,
resolves the principal through [`resolvePrincipal`](#authentication) when the
route carries a requirement, reads and validates a `POST` body against the
route's own schema, and writes the handler's `Html` with
`content-type: text/html; charset=utf-8`. A request no route claims resolves
unwritten, exactly like oRPC's answerer, so the runtime's own `404` answers
it.

| Option   | Required | Default | What it is                  |
| -------- | -------- | ------- | --------------------------- |
| `prefix` | no       | `/`     | where fragments are mounted |

Only `bodyLimit`, off the same `HttpConfig` `orpc()` reads, applies to this
answerer — `cors` and `compression` are oRPC plugins with no fragment
equivalent.

::: warning
**Routes are matched in the composition root's own array order, first match
wins — and that ordering is a security property, not only a routing one.**
An unmarked route declared before a marked route whose path can also match
the same request answers it, and no authentication ever runs: two routes are
two port ids, minted from their own method and path, so di has nothing to
see collide, and there is deliberately no specificity rule to fall back on.
:::

**The `POST` body decodes through `Object.fromEntries(new
URLSearchParams(...))`, which keeps only the last value for a repeated key.**
A `<select multiple>` or a checkbox group both collapse to their last
selection rather than an array — a mainstream htmx shape a reader should meet
here, not discover in production.

**The decoding also assumes `application/x-www-form-urlencoded` and never
checks `content-type`.** A JSON body still passes through
`new URLSearchParams(...)`, which reads the whole payload as one garbage key
with an empty value — form-urlencoded only, the same stated limitation as the
repeated-key one above rather than a validated content type.

**Every `200` carries `Cache-Control: no-store`, unconditional.** A public
route can still render a caller- or resource-scoped fragment off a path
parameter alone, and this package has no way to know a route's output is safe
for a shared cache to keep — so there is no cheaper signal than "never store"
to key the header on.

**A route always answers `200` on success, and cannot set a header or a
status of its own.** `HX-Redirect`, `HX-Trigger`, `HX-Retarget` and
`HX-Reswap` — htmx's own response mechanics — are unreachable, and a route
cannot answer its own `404` or `422`: "not found" is rendered markup (see
[Serve htmx fragments](/how-to/serve-htmx-fragments)'s `orderRow` recipe),
never a status. A defensible scope decision, not an oversight.

**A refusal — `401`/`403`/`413`/`422` — carries no body**, unlike the
runtime's own `404`/`500` fallback (see
[What it decides about a request](#what-it-decides-about-a-request)), which
carries `application/json`: a refusal owes the caller nothing beyond the
status.

## `HttpConfig`, and the environment

`HttpConfig` is `{ port, hostname, bodyLimit, corsOrigin, compression }`, bound
through [`Config.provider`](/reference/config) from the `Env` port the kernel
provides. Each option **pins** its field: explicit > environment > default, per
field, so `http({ port: 0 })` still reads `HOST` — and still reads
`HTTP_BODY_LIMIT`.

| Variable           | Default     | Parsed by        | Notes                                                                                                      |
| ------------------ | ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `PORT`             | `3000`      | `Config.port`    | `0` lets the OS pick; read the bound port back from `RunningApp.runtimeInfo()`                             |
| `HOST`             | `0.0.0.0`   | `Config.string`  | the deployment target is a pod; set `127.0.0.1` locally if the server must not be reachable off-host       |
| `HTTP_BODY_LIMIT`  | `1048576`   | `Config.integer` | bytes; `0` is unbounded. The one policy whose default is **on** — see [above](#cors-bodylimit-compression) |
| `HTTP_CORS_ORIGIN` | unset (off) | `Config.string`  | comma-separated origins, or `*`; setting it is what turns CORS on                                          |
| `HTTP_COMPRESSION` | `false`     | `Config.boolean` | `true`/`false`, `1`/`0`, `yes`/`no`, `on`/`off`                                                            |

An unset variable takes the default; a set-but-empty one, `PORT=abc` and
`PORT=70000` are each a `ConfigInvalid` — a `startFailed` event and exit `78`
under `runMain`. Anything in the graph may depend on `HttpConfig`.

## `HttpHandler`, and several answerers

`HttpHandler` is a **set port**: every protocol served in this process
contributes one `HttpAnswerer`, and the runtime routes each request to the one
whose `prefix` matches **longest**.

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type HttpAnswerer = {
  readonly prefix: `/${string}`;
  readonly handle: (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => PromiseLike<unknown>;
};
```

| Request       | Mounted answerers     | Answers                                                                    |
| ------------- | --------------------- | -------------------------------------------------------------------------- |
| `/rpc/orders` | `/` and `/rpc`        | `/rpc` — the longest match                                                 |
| `/orders/42`  | `/` and `/rpc`        | `/` — everything else                                                      |
| `/graphql`    | `/graphql`            | `/graphql` — the mount point itself                                        |
| `/rpcx`       | `/rpc`                | the runtime's `404` — a mount point is a path segment, not a string prefix |
| `/orders/42`  | `/rpc` and `/graphql` | the runtime's `404` — no mount covers it                                   |

A graph holds exactly one runtime, so several protocols cannot be several
runtimes; they are several answerers under one. Nesting is expected rather than
refused, which is why there is no ordering to configure: only a **duplicate**
mount point is an error, and it is a `RuntimeStartFailed` at `listen` rather
than a coin toss. A trailing slash is the same mount, so `/rpc` and `/rpc/`
collide.

The runtime reads the members through `Runtime.resolves` rather than through
di, because a member contributed by a **sibling** module is not visible from
inside the starter's own. That is why `HttpRuntime` resolves `HttpHandler` and
the composition root must export it — [`HttpModule`](#httpmodule-name) adds it
for you, and `start`'s `UNSATISFIED RUNTIME PORTS` names it when a hand-written
root forgets.

::: warning
An answerer outside an oRPC contract carries its **own** authentication.
`@btravstack/contract`'s marker is what says which scheme protects a procedure,
and a GraphQL operation or an HTML fragment has no such statement — so its
routes are public unless the answerer brings authentication itself, exactly as
an unmarked procedure is public, and with the same absence of a gate for "you
forgot".
:::

## `HttpRuntime` and `HttpInfo`

`HttpRuntime` is declared over the kernel's `RuntimePort` with service
`Runtime<typeof HttpHandler, HttpInfo>`: the runtime **resolves
[`HttpHandler`](#httphandler-and-several-answerers)**, and reads its members off
`RuntimeHost.ctx` — the one thing it reads there, and the reason a composition
root must export that port. It resolved nothing while the oRPC answerer was the
only one and its provider could depend on the router directly; a sibling
module's answerer is not visible that way. Once
listening it publishes `HttpInfo`, `{ port }`, on `Serving.info`; with `PORT=0`
that is the only way to learn the port that was actually bound.

## What it decides about a request

| Request                                                      | Answer                                                                 | Decided by       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------- |
| a procedure under `prefix`                                   | the procedure's output, or the `ORPCError` its `Result` was mapped to  | oRPC, the router |
| a defect thrown inside a procedure                           | oRPC's own `INTERNAL_SERVER_ERROR` collapse                            | oRPC             |
| a protected procedure no requirement accepted the caller for | `401 UNAUTHORIZED`, the handler never entered                          | this package     |
| a protected procedure whose caller lacked a required scope   | `403 FORBIDDEN`, the handler never entered                             | this package     |
| a protected procedure whose authenticator defected           | oRPC's `INTERNAL_SERVER_ERROR` collapse — a bug, not a rejected caller | oRPC             |
| a path under `prefix` naming no procedure                    | `404 {"error":"NotFound"}` — oRPC declines it unwritten                | this package     |
| any path outside `prefix`                                    | `404 {"error":"NotFound"}` — likewise                                  | this package     |
| the listener resolved without writing                        | `404 {"error":"NotFound"}`                                             | this package     |
| the listener failed before headers were out                  | `500 {"error":"InternalError"}`                                        | this package     |
| a failure with headers already on the wire                   | the socket is destroyed — a reset, not a hang                          | this package     |

The last three are the package's own fallbacks, guaranteeing that every
request produces exactly one completed response. The two `500` shapes are
unreachable over the oRPC surface, which collapses every defect itself; they
exist because the transport is proven against a bare listener. "Failed"
covers a rejected promise, a synchronous throw, and a `StartOptions.unit`
provider that failed to build — the last two never reach the listener's
promise, so that `500` is written from the unit's own defect path.

`Result` → HTTP status is deliberately **not** in the table: it is the
router's `.result()` triage, at the one place that decides what a client sees.

## The unit

One unit per request, `kind: "http"`. Its lifetime **is** the response's: the
unit's work resolves on the response's `'close'` event (or at once if that
already fired before the work ran — a client hanging up during a slow
`StartOptions.unit` build), so there is no seam for a late write to land in.

| `UnitMeta` field | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `id`             | `randomUUID()`, minted per request — never the route, which would give every request one trace id |
| `traceId`        | the inbound `x-request-id` header when **non-blank**; otherwise absent, so it defaults to `id`    |

A blank header is ignored rather than adopted, because `""` is not nullish
and would otherwise win over the minted id.

## The drain

`Serving.drain(signal)` marks the server draining, **retires every open
response** — an unsent header gets `Connection: close`, a sent one ends its
socket on `'finish'` — then calls `server.close()` and
`closeIdleConnections()`. `closeIdleConnections()` alone reaches only
connections idle at that instant, and node would keep serving keep-alive
requests down a busy one for the whole drain window; retirement per response
is what actually stops accepting. The deadline `signal` is noted and not
otherwise used: closing a listener is instantaneous, so there is nothing to
escalate to. `Serving.stop()` destroys whatever sockets are still open and
resolves once the server has closed.

## Startup failures

A bind failure (`EADDRINUSE`, and the synchronous `ERR_SOCKET_BAD_PORT` node
throws for a port outside `0..65535`) is
`Err(RuntimeStartFailed({ runtime: "http", cause }))` — exit `1` under
`runMain`. Once serving, the server keeps a permanent no-op `'error'` listener
so a transient accept fault cannot become an `uncaughtException` teardown.

## Peer dependencies

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`,
`@btravstack/contract`, `unthrown`, `@orpc/server`, `@orpc/contract`,
`@unthrown/orpc`. All peers, so an application holds one copy of each —
`@btravstack/contract` most of all, since its marker is a `unique symbol` and
two copies are two different symbols, so a contract marked against one would
read as unmarked here. Node `>=22`.

## Deliberately not included

- **Another router in oRPC's answerer.** oRPC through `@orpc/server/node`'s
  `RPCHandler` is how this package answers HTTP, and there is no `handler`
  option to swap it. A second protocol is a second answerer on the
  [`HttpHandler`](#httphandler-and-several-answerers) set port under the same
  runtime.
- **A middleware slot for application logic.** oRPC's own, inside the
  router's procedures. `principalMiddleware` is the one per-request hook the
  package installs, only on a leaf whose requirements say so.
  [`plugins`](#plugins) is an honest
  escape hatch rather than a keyhole — a plugin can reach the handler's
  interceptors — but the ordinary path is configuration visible at the
  composition root ([`cors`, `bodyLimit`, `compression`](#cors-bodylimit-compression),
  [`securityHeaders`](#securityheaders)), and an application middleware acting
  on the handler's `Result` is what this package refuses.
- **`Result` → HTTP status.** The router's `.result()` triage owns it.
- **Resource-dependent authorization.** A **scope** is checked here, because it
  is a property of the credential and answerable before dispatch. "Is this
  caller the order's owner?" is not, and stays in the handler.
- **AND within one requirement.** A requirement names one scheme; requiring two
  credentials at once would put a record rather than an identity on the
  handler. A composite scheme models it where it is genuinely needed.
- **OpenAPI document metadata.** A scheme's own definition — `type: http`,
  `bearerFormat`, an OAuth flow — belongs beside the contract, not in
  `defineHttp`.
- **HTTPS, HTTP/2.** `node:http` only; terminate TLS at the ingress.

## `openApiDocument()` — from `@btravstack/http-server/openapi`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled by the package's own specs -->

```ts
const document = (
  await openApiDocument(contract, {
    base: { info: { title: "Order API", version: "1.0.0" } },
    securitySchemes: { user: { type: "http", scheme: "bearer" } },
  })
).get();
```

It returns `AsyncResult<OpenApiDocument, never>` — async, and cannot fail — so
`.get()` is the extraction; a generator fault arrives as a defect, never a raw
rejection. `base` is `Partial<OpenApiDocument>` and `securitySchemes` is
`OpenApiSecuritySchemes` (the document's own `components.securitySchemes`
shape), so a key the generator would ignore is a type error rather than
silently inert.

The contract as an OpenAPI document, with
[`@btravstack/contract`](/reference/contract)'s marker folded into each
operation's `security`.

**A fold, not a translation.** `Requirement` is
`Readonly<Record<string, readonly string[]>>` and `Requirements` an array of
them — byte-identical to OpenAPI's `SecurityRequirementObject[]`, keys within
one object AND, separate objects OR. The emitted `security` is the marker's own
value; nothing is reinterpreted, which is why the OR rule the contract already
enforces survives into the document intact.

A document from this stack therefore carries **OR and never AND** — not a
limitation of the generator but of what a contract can say:
[`@btravstack/contract`](/reference/contract) refuses the multi-key requirement
OpenAPI reads as AND, because this package would run it as OR.

**`securitySchemes` is yours to supply.** The contract says WHICH schemes
protect a route and deliberately never says what a scheme IS — the same split
`defineHttp({ authenticators })` makes, one layer out: the authenticators say
what `user` resolves to for the server, this says what it looks like to a
client. A scheme the contract names with no definition still appears in
`security`, as a visible unresolvable reference rather than a silently dropped
requirement.

`@orpc/openapi` and `@orpc/json-schema` are **optional peers** behind the
subpath, so an application that never asks for a document installs neither.

### Nothing serves it

This package mounts no documentation route and ships no UI asset. A Swagger UI
bundle inside a transport package would be a runtime dependency for every
consumer, including the ones who never ask for a document — so an application
serves the value from a route of its own. `examples/order-api/src/openapi.ts`
is the whole recipe.
