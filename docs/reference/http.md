---
title: "@btravstack/http"
description: The HTTP starter — HttpModule, HttpRouter, HttpController, HttpAuthenticator, http(), HttpRuntime, HttpConfig and HttpInfo, plugins and securityHeaders, what each request is answered with, and how the drain retires a keep-alive connection.
---

# @btravstack/http

> **Reference.** A complete, structured description of the HTTP starter's
> public surface: every export of `@btravstack/http`, its options and their
> defaults, and what the package decides about a request. For the task, see
> [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http); for the
> reasoning behind a starter, see [Starters](/explanation/starters) and
> [The kernel maps nothing](/explanation/the-kernel-maps-nothing); for the
> worked example, [Order API](/examples/order-api). Generated signatures are
> under [API reference](/api/http/).

## Exports

`packages/http/src/index.ts` exports exactly this:

| Export                 | Kind  | What it is                                                                                                                                                                                                                                        |
| ---------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HttpModule`           | value | `HttpModule(name)({ router, authenticator?, prefix?, port?, hostname?, plugins?, securityHeaders?, imports?, provides?, exports? })` — a di `Module(name)({...})` that also takes the router provider; the composition root of an HTTP deployment |
| `HttpModuleOptions`    | type  | The options object `HttpModule(name)` takes                                                                                                                                                                                                       |
| `HttpRouter`           | value | `HttpRouter(contract)(deps, { sync })`, or `HttpRouter(contract)(controllers)` — the router as a provider on the starter's own router port, contract-first, either from one `sync` or from a keyed record of controllers                          |
| `HttpController`       | value | `HttpController(name, fragment)({ name: Dep }, { sync })` — one slice of a contract, as a provider on a port minted for it                                                                                                                        |
| `HttpAuthenticator`    | value | `HttpAuthenticator<P>()({ name: Dep }, { sync })` — the provider that turns a request's headers into a principal `P`, on `AuthenticatorPort`                                                                                                      |
| `httpAuth`             | value | `httpAuth<Identity>()` — mints `HttpController`, `HttpRouter` and `HttpAuthenticator` fixed to the server's own identity; the only thing that gives a marked handler a readable `context.principal`                                               |
| `HttpAuth`             | type  | what `httpAuth<Identity>()` returns — the three, as one type                                                                                                                                                                                      |
| `HttpControllerOf`     | type  | `HttpControllerOf<Identity>` — the annotation a file exporting the factory's `HttpController` needs                                                                                                                                               |
| `HttpRouterOf`         | type  | `HttpRouterOf<Identity>` — the same, for the router                                                                                                                                                                                               |
| `HttpAuthenticatorOf`  | type  | `HttpAuthenticatorOf<Identity>` — the same, for the authenticator                                                                                                                                                                                 |
| `AuthenticatorPort`    | value | `Port("HttpAuthenticator")` over `AuthenticatorService<unknown>` — the port a marked contract's router depends on                                                                                                                                 |
| `AuthenticatorService` | type  | `(headers: IncomingHttpHeaders) => AsyncResult<P, Unauthenticated>` — headers in, principal out                                                                                                                                                   |
| `Unauthenticated`      | value | a `TaggedError` with an empty payload — the refusal itself; the starter surfaces no reason to the client                                                                                                                                          |
| `HasMark`              | type  | `HasMark<C>` — exactly `true` or `false`: whether the contract marks anything, anywhere in its tree                                                                                                                                               |
| `http`                 | value | `http({ prefix?, port?, hostname?, plugins?, securityHeaders? })` — the starter module itself, needing the router port; what `HttpModule` imports                                                                                                 |
| `HttpOptions`          | type  | `http()`'s options                                                                                                                                                                                                                                |
| `HttpRuntime`          | value | `class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}` — the runtime's port; what `http()` provides and the module `start` boots must export                                                                                        |
| `HttpConfig`           | value | `class HttpConfig extends Port("HttpConfig")<{ port: number; hostname: string }> {}` — what the socket is bound with, provided by `http()` from `PORT` / `HOST`                                                                                   |
| `HttpInfo`             | type  | `{ readonly port: number }` — what the runtime publishes on `Serving.info` once listening, read back through `RunningApp.runtimeInfo()`                                                                                                           |

`HttpRouterPort` (the starter's router port, `Port("HttpRouter")`),
`Implementation<C>` (the record type `HttpRouter`'s `sync` returns) and
`HttpHandler` (the node listener port) exist in `src/orpc.ts` and
`src/handler.ts` but are **not** exported from the package entry point: the
first is reached as `provider.port` when a caller needs it, the second is
inferred at the call, the third is an internal seam.

## `HttpModule(name)({...})`

Everything `Module(name)({...})` takes — `imports`, `provides`, `exports` —
plus the starter's own fields. It appends
`http({ prefix, port, hostname, plugins, securityHeaders })` to `imports`,
prepends `router` (and `authenticator`, when one is given) to `provides`,
prepends `HttpRuntime` to `exports`, and hands the augmented tuples to di's own
`Module(name)`, whose return type is the sugar's. The kernel and both gates see
a plain module.

| Option            | Required | Default          | What it is                                                                                                                                                                 |
| ----------------- | -------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `router`          | yes      | —                | the application's router **provider** — a `Provider<HttpRouterPort, E, N>`, what `HttpRouter(contract)(deps, arm)` returns; a provider on any other port fails at the call |
| `authenticator`   | no\*     | —                | what `HttpAuthenticator<P>()({ name: Dep }, { sync })` returns; \*owed whenever the contract marks anything (see [Authentication](#authentication))                        |
| `prefix`          | no       | `/rpc`           | where the RPC endpoint is mounted; typed `` `/${string}` ``                                                                                                                |
| `port`            | no       | read from `PORT` | pins the port instead of reading it                                                                                                                                        |
| `hostname`        | no       | read from `HOST` | pins the host instead of reading it                                                                                                                                        |
| `plugins`         | no       | `[]`             | oRPC handler plugins, forwarded to `RPCHandler` — CORS, body limits, compression, CSRF                                                                                     |
| `securityHeaders` | no       | `true`           | response headers set on the raw listener, before dispatch                                                                                                                  |
| `imports`         | no       | `[]`             | the application's modules                                                                                                                                                  |
| `provides`        | no       | `[]`             | the application's own providers                                                                                                                                            |
| `exports`         | no       | `[]`             | the application's own exports; `HttpRuntime` is added                                                                                                                      |

The worked composition root, from `examples/order-api/src/module.ts`:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  authenticator: bearerAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

That is exactly the module
`Module("OrderApi")({ imports: [OrdersSlice, CustomersSlice, observability(), http()], provides: [orderRouter, bearerAuthenticator], exports: [HttpRuntime, Logger] })`
would have declared. `authenticator` is a plain optional field: present, it
joins `provides`, which is all discharging di's need takes.
[`observability()`](/reference/observability) is a second
starter, not this package's business: it brings the `Logger` the application
writes to, bound from `LOG_LEVEL`, JSON per line on stdout, every line
carrying the trace id of the unit this runtime opened.

## `HttpRouter(contract)(deps, { sync })`

Contract-first: `contract` is an oRPC router record (`Record<string,
RouterContract>` — a record, not a bare procedure), and the second call is
di's `Provider(port)(deps, { sync })` on the starter's own router port with one
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
runtime, so the port is the starter's — `Port("HttpRouter")`, declared once,
framework-owned like `HttpConfig` — and two router providers in one graph are
di's duplicate-provider defect at build. Returns
`Provider<PortInstance<"HttpRouter", Router<…>>, never, InstanceType<D[keyof D]>> & { readonly port: PortClassOf<"HttpRouter", Router<…>> }` —
`provider.port` is the port class, for a hand-declared provider or a type
test. The implementation below is the one in
`examples/order-api/src/slices/orders/controller.ts`, served through the
deps form — the example composes it as a controller instead (see the
keyed form), and a fragment is a contract, so the same `sync` reads either way.
`contract.orders` is `authenticated`, so `HttpRouter` here is the application's
own — `httpAuth<Identity>()`'s, from its `src/auth.ts` — and the tenant comes
off `context.principal` rather than off the input:

```ts
export const ordersRouter = HttpRouter(contract.orders)(
  { place: PlaceOrder, find: FindOrder },
  {
    sync: ({ place, find }) => ({
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
    }),
  },
);
```

An implementation key the contract does not declare is unreachable through
the types; if one is smuggled past them it is dropped, not defected on.

### The keyed form: `HttpRouter(contract)(controllers)`

For a `contract` shaped `Record<string, RouterContract>`, `HttpRouter`
also takes a **record of controllers**, one per top-level key, instead of
`(deps, { sync })`:

```ts
export const orderRouter = HttpRouter(contract)({
  orders: ordersController,
  customers: customersController,
});
```

Each value is what [`HttpController`](#httpcontrollername-fragment)
returns. The call is **exact**: `M` is constrained to
`{ readonly [K in Exclude<keyof C, PrincipalKey>]: ControllerFor<Inherit<C[K],
IsMarked<C>>, Identity> }`, and the `controllers`
**parameter** itself is typed `M & { readonly [K in Exclude<keyof M,
Exclude<keyof C, PrincipalKey>>]: never }` — the exactness intersection sits on
the parameter, not on `M`, so a key `C` does not declare is typed `never` there
without collapsing `M` (and with it the needs channel di orders the controllers
by) to `never` too. The `Exclude`/`Inherit` pair is the same one
[`Implementation<C>`](#authentication) carries: a contract marked at its
**root** composes through this form too, and each fragment inherits that mark,
so a controller under it types `context.principal`.
Five gates are pinned by
`packages/http/src/controller.test-d.ts`: every contract key must be covered;
a key the contract does not declare is rejected; a controller wired under the
wrong key is rejected (its fragment does not match that key's); a
procedure a controller's own fragment does not declare is rejected inside the
controller, before the root ever sees it; and a slice lifts into a process of
its own with its controller untouched —
`HttpRouter(contract.orders)({ implementation: ordersController.port }, { sync: ({ implementation }) => implementation })`
compiles — the property a slice's independent deployability
rests on. The `(deps, { sync })`
form is unchanged and stays correct for a small API — the two are
discriminated **by arity** at the call, the same way
`Provider(port)(depsOrOptions, …)` discriminates its own two forms, since a
deps record and a controllers record are both objects. See
[Split a router into controllers](/how-to/split-a-router-into-controllers) for
the worked recipe.

## `HttpController(name, fragment)`

```ts
const HttpController: <const Name extends string, C extends RouterContract>(
  name: Name,
  fragment: C,
) => <const D extends Readonly<Record<string, AnyPort>>>(
  deps: D,
  options: {
    readonly sync: (services: {
      readonly [K in keyof D]: ServiceOf<InstanceType<D[K]>>;
    }) => Implementation<C>;
  },
) => Provider<
  PortInstance<Name, Implementation<C>>,
  never,
  InstanceType<D[keyof D]>
> & {
  readonly port: PortClassOf<Name, Implementation<C>>;
};
```

One slice of a contract, as a provider over a port minted for it — the same
two-call shape as `HttpRouter(contract)({ name: Dep }, { sync })`, aimed at a
`fragment` rather than the whole contract. `fragment` is read for its
**type** only: it shapes `sync`'s return, so a procedure the fragment does
not declare, or a handler whose input or output has drifted, is a compile
error inside the controller. The port is minted under `name` and carried
back on `provider.port` — the shape `Config.provider("RelayConfig")(schema)`
already uses — so a slice's module exports `controller.port` rather than
naming a port of its own:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  provides: [ordersController],
  exports: [ordersController.port],
});
```

The controller does no oRPC work: it is a plain record, and `HttpRouter`'s
own walk wraps each leaf in `.result(...)` when the keyed form composes the
router. **A fragment is itself a valid contract**, so a slice lifts out into a
process of its own without its controller changing at all — the lifted root
declares the controller's own port and hands back what it built:

```ts
export const ordersRouter = HttpRouter(contract.orders)(
  { implementation: ordersController.port },
  { sync: ({ implementation }) => implementation },
);
```

That property is marked do-not-break: it is what makes composing several
slices into one router a starting point rather than a trap.

## Authentication

A contract marked with [`@btravstack/contract`](/reference/contract)'s
`authenticated` is what turns this on. Nothing here is a switch on the
starter: the marker is a fact about the contract, and both halves of the
package follow it.

**In the types.** `Implementation<C, Identity>` branches on the marker. A
marked **leaf** gets `{ readonly principal: Identity }` in its implementer's
injected context, so the handler reads `opts.context.principal` — oRPC's own
context channel, not a second handler parameter this package invents and not a
wrapper around `.result()`. A marked **record** pushes its marker onto each
child, so a marked fragment protects every procedure beneath it. An unmarked
leaf's context is unchanged, which is what makes reading a principal there a
compile error. `HasMark<C>` is whether the contract marks anything anywhere in
its tree — a yes/no, since the contract names no principal to recover.

**At runtime.** `HttpRouter`'s walk carries the mark down the contract exactly
as the types do, and a marked leaf is built as
`node.use(principalMiddleware(authenticate)).result(fn)` — `.use` before
`.result`, which is the only order oRPC leaves available. The middleware reads
the request off oRPC's initial context, calls the authenticator with its
headers, and either injects `{ context: { principal } }` or terminates the
request.

### `HttpAuthenticator<P>()({ name: Dep }, { sync })`

An ordinary di provider on `AuthenticatorPort`, whose service is
`AuthenticatorService<P>`:

```ts
type AuthenticatorService<P> = (
  headers: IncomingHttpHeaders,
) => AsyncResult<P, Unauthenticated>;
```

**Headers, not the request**: an authenticator has no business reading a body,
and the narrower argument is what keeps it testable without a socket. `deps`
are di's, so a JWT verifier or a user directory is injected the way any
provider's dependencies are. The type argument is **explicit** rather than
inferred from `sync` — inference through a returned function's `AsyncResult` is
where a principal silently widens to `unknown` — though in an application that
has an `src/auth.ts` the argument is already fixed by `httpAuth<Identity>()`
and the call is `HttpAuthenticator({ name: Dep }, { sync })`. `Unauthenticated` is a
`TaggedError` with an **empty payload**: the starter surfaces no reason, so a
field would be write-only. A rejected caller gets an `UNAUTHORIZED` and oRPC's
default message; an authenticator that wants to record why logs it before
returning. Forwarding a reason would put "no such user" versus "bad signature"
in a 401 body by default.

```ts
export const bearerAuthenticator = HttpAuthenticator(
  {},
  {
    sync: () => (headers) => {
      const header = headers.authorization ?? "";
      const token = header.startsWith("Bearer ")
        ? header.slice("Bearer ".length)
        : "";
      const [tenantId, userId] = token.split(":");
      return tenantId === undefined ||
        tenantId === "" ||
        userId === undefined ||
        userId === ""
        ? ErrAsync(new Unauthenticated())
        : OkAsync({ tenantId, userId });
    },
  },
);
```

### `httpAuth<Identity>()` — what the principal is, server-side

**The contract says _whether_ a route is protected; this says _what_ the
principal is.** The contract names no identity type at all, so nothing about
the server's view of a caller reaches a client — and this factory is the only
thing that gives a marked handler a readable `context.principal`. It states the
identity once and hands back the three pieces fixed to it:

```ts
// src/auth.ts — one per application
export type Identity = { readonly tenantId: string; readonly userId: string };

const identity = httpAuth<Identity>();

export const HttpController: HttpControllerOf<Identity> =
  identity.HttpController;
export const HttpRouter: HttpRouterOf<Identity> = identity.HttpRouter;
export const HttpAuthenticator: HttpAuthenticatorOf<Identity> =
  identity.HttpAuthenticator;
```

Every slice imports `HttpController` from there, and its marked handlers see
`Identity` on `context.principal` with no annotation of their own; nothing else
about a controller changes. The `HttpAuthenticator` handed back is already
applied, so it is called `HttpAuthenticator({ name: Dep }, { sync })` — which is also
why the authenticator and the controllers cannot disagree about the identity.

It is per application rather than per slice because a handler's parameter types
are fixed **where the arrow is written**: a composition root cannot re-type a
`sync` callback that lives in another module, so the identity has to be in
scope where the handler is. The three `…Of<Identity>` aliases are annotations
rather than ceremony — a controller's port expands to a type carrying the
marker's phantom `unique symbol`, which a consumer's own `.d.ts` cannot name.

The identity reaches a **marked** node only, and none is invented on an
unmarked one: the contract still decides _whether_. `HttpController` and
`HttpRouter` imported from the package itself are the `Identity = never` case —
a marked fragment reached through them types `principal: never`, so every read
is a compile error. That is the signal to use the factory, not a fallback.

### Two gates, and why they are two

When the contract marks anything, `HttpRouter` adds `AuthenticatorPort` to the
router provider's deps record under a **namespaced** key
(`"@btravstack/http/authenticator"`, so it cannot collide with one you wrote),
strips it back out before your own `sync` sees the record, and adds it to the
provider's needs channel. Which makes a marked router with no authenticator behind it di's
existing `UNSATISFIED DEPENDENCIES` gate at `start`, not a gate this package
invented.

What di cannot see is the **identity**: `AuthenticatorPort`'s service type is
erased to `unknown`, so any authenticator discharges that need. So
`HttpModule` checks the other half — the **router's** identity, inferred from
`router.identity`, against the **authenticator's**. A router minted by
`httpAuth<A>()` refuses an authenticator minted by `httpAuth<B>()`, at the
`HttpModule(...)` call. The direction is `AuthIdentity extends RouterIdentity`:
the authenticator must resolve **at least** what the handlers read, so a
subtype discharges it. A router from the package's own top-level `HttpRouter`
carries no identity and accepts any authenticator, including none — a provider
nothing needs is di's business and not an error to invent.

A mark with no authenticator behind it still **fails closed**: an internal
`noAuthenticator` refuses every caller, so such a leaf answers `401` rather
than serving unprotected. It is unreachable while the types and the walk
agree, which is exactly why it is there.

### The marker is legibility, not enforcement

An unmarked procedure is public, and **nothing fails if the marker is
forgotten** — no compile error, no startup failure. There is no
deny-by-default here; the contract makes a protected route visible to both
sides, and that is all it claims. See
[Protect a procedure](/how-to/protect-a-procedure).

## `http(options)`

```ts
const http: (
  options?: HttpOptions,
) => Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort>;
```

The primitive `HttpModule` delegates to, for a composition root written by
hand. `HttpOptions`:

| Option            | Required | Default          | What it is                                                      |
| ----------------- | -------- | ---------------- | --------------------------------------------------------------- |
| `prefix`          | no       | `/rpc`           | where the RPC endpoint is mounted                               |
| `port`            | no       | read from `PORT` | pins the port                                                   |
| `hostname`        | no       | read from `HOST` | pins the host                                                   |
| `plugins`         | no       | `[]`             | `NodeHttpHandlerPlugin[]`, forwarded to oRPC's own `RPCHandler` |
| `securityHeaders` | no       | `true`           | `boolean \| Record<string, string>`, applied on the listener    |

The module **provides** `HttpRuntime` and `HttpConfig`, exports both, and
**needs** `Env` (the kernel discharges it) and the starter's router port
(`HttpRouterPort`, the port `HttpRouter(contract)(deps, arm)` provides on) —
the runtime provider depends on the router through di, which is why a
composition that imports `http()` without providing the router carries an
unmet need `start` refuses (di's gate, not the kernel's). The router is not an
option: there is no other port it could be on. The
declared type is the same whether or not a field is pinned: `Env` and
`ConfigInvalid` stay in the signature, and a pinned config never produces the
latter.

### `plugins`

`readonly NodeHttpHandlerPlugin<DefaultInitialContext>[]`, from
`@orpc/server/node`, forwarded straight to `new RPCHandler(service, { plugins })`.
CORS, body limits, compression and CSRF are transport policy oRPC already
expresses as handler plugins, so the ordinary use is **configuration** rather
than a middleware slot for application logic —
`plugins: [new CORSHandlerPlugin({ origin: () => "https://orders.example" })]`
on `HttpModule` or `http()`, with the plugin imported from
`@orpc/server/plugins`.

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

## `HttpConfig`, and the environment

`HttpConfig` is `{ port, hostname }`, bound through
[`Config.provider`](/reference/config) from the `Env` port the kernel provides.
`port` / `hostname` in the options **pin** a field: explicit > environment >
default, per field, so `http({ port: 0 })` still reads `HOST`.

| Variable | Default   | Parsed by       | Notes                                                                                                |
| -------- | --------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| `PORT`   | `3000`    | `Config.port`   | `0` lets the OS pick; read the bound port back from `RunningApp.runtimeInfo()`                       |
| `HOST`   | `0.0.0.0` | `Config.string` | the deployment target is a pod; set `127.0.0.1` locally if the server must not be reachable off-host |

An unset variable takes the default; a set-but-empty one, `PORT=abc` and
`PORT=70000` are each a `ConfigInvalid` — a `startFailed` event and exit `78`
under `runMain`. Anything in the graph may depend on `HttpConfig`.

## `HttpRuntime` and `HttpInfo`

`HttpRuntime` is declared over the kernel's `RuntimePort` with service
`Runtime<never, HttpInfo>`: the runtime declares **no needs** — the router is
a port its provider depends on — so `RuntimeHost.ctx` goes unread. Once
listening it publishes `HttpInfo`, `{ port }`, on `Serving.info`; with `PORT=0`
that is the only way to learn the port that was actually bound.

## What it decides about a request

| Request                                                           | Answer                                                                 | Decided by       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------- |
| a procedure under `prefix`                                        | the procedure's output, or the `ORPCError` its `Result` was mapped to  | oRPC, the router |
| a defect thrown inside a procedure                                | oRPC's own `INTERNAL_SERVER_ERROR` collapse                            | oRPC             |
| a marked procedure whose authenticator returned `Unauthenticated` | `401 UNAUTHORIZED`, the handler never entered                          | this package     |
| a marked procedure whose authenticator defected                   | oRPC's `INTERNAL_SERVER_ERROR` collapse — a bug, not a rejected caller | oRPC             |
| a path under `prefix` naming no procedure                         | `404 {"error":"NotFound"}` — oRPC declines it unwritten                | this package     |
| any path outside `prefix`                                         | `404 {"error":"NotFound"}` — likewise                                  | this package     |
| the listener resolved without writing                             | `404 {"error":"NotFound"}`                                             | this package     |
| the listener failed before headers were out                       | `500 {"error":"InternalError"}`                                        | this package     |
| a failure with headers already on the wire                        | the socket is destroyed — a reset, not a hang                          | this package     |

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
read as unmarked here. Node `>=20`.

## Deliberately not included

- **Any other router or handler.** oRPC through `@orpc/server/node`'s
  `RPCHandler` is the one way HTTP is answered; there is no `handler` option
  and no listener port to provide.
- **A middleware slot for application logic.** oRPC's own, inside the
  router's procedures. `principalMiddleware` is the one per-request hook the
  package installs, only on a marked leaf. [`plugins`](#plugins) is an honest
  escape hatch rather than a keyhole — a plugin can reach the handler's
  interceptors — but the ordinary path is configuration visible at the
  composition root, and an application middleware acting on the handler's
  `Result` is what this package refuses.
- **`Result` → HTTP status.** The router's `.result()` triage owns it.
- **HTTPS, HTTP/2.** `node:http` only; terminate TLS at the ingress.
