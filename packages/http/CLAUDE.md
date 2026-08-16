# packages/http

The HTTP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/http/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`HttpModule(name)({ router, prefix?, port?, hostname?, imports?, provides?, exports? })`**
  (`http-module.ts`) — THE way an application declares an HTTP deployment:
  `Module(name)({...})` plus the router **provider**. It appends
  `http({ prefix?, port?, hostname? })` to `imports`, prepends the provider to
  `provides` and `HttpRuntime` to `exports`, and hands the augmented tuples —
  `Imports<I>` / `Provides<P, RouterError, RouterNeeds>`, readonly and exact
  — to di's own `Module(name)({...})`, whose
  return type IS the sugar's: nothing spelled twice. di exports `AnyModule`,
  `AnyProvider` and `Exportable` for exactly that (constraining the tuples the
  way `Module(name)` does); its other module-typing pieces stay internal.
  (Spelling the return through a named generic alias was tried and removed:
  declaration emit keeps such an alias unreduced and cannot name imported
  modules' internal ports — TS2883, measured.) `router` is a plain
  `Provider<HttpRouterPort, RouterError, RouterNeeds>` — a provider on the
  starter's own router port, which is what `HttpRouter(contract)(deps, arm)`
  returns — so a provider of anything else fails at the call, and there is no
  port to read off it: the starter needs `HttpRouterPort`, and the sugar's
  job is to provide it. Covered by the package's own `rpc` fixture, which
  composes `RpcApp` through it. Options `port`/`hostname` pin as for `http()`.
- **`HttpRouterPort`** (`orpc.ts`, exported from the file for the package's
  own tests, **not** from `index.ts`) — the router's port, one id, the
  starter's own: `Port("HttpRouter")` cast to di's `PortClassOf<"HttpRouter",
Router<Record<never, never>>>`, with the matching `PortInstance` alias. A
  process serves one router as it boots one runtime (thesis #1), so there is
  nothing to name, and the port is framework-owned like `HttpConfig` and
  `HttpRuntime`; two router providers in one graph are di's duplicate-provider
  defect at build, which is correct. The service type is contract-agnostic
  (a context-free oRPC router), so this is one concrete port — unlike the
  temporal and amqp starters', which are typed per contract.
- **`HttpRouter(contract)(deps, { sync })`** (`orpc.ts`) — contract-first
  router provider. `Implementation<C>` is the record type: recursing the
  contract's shape, each `ProcedureContract<I, O, E>` becomes
  `Parameters<ProcedureImplementer<DefaultInitialContext & object, object, I,
O, E>["result"]>[0]` — the `.result()` handler `@unthrown/orpc` gives that
  procedure's implementer (`import "@unthrown/orpc/extensions/result"` here;
  `@orpc/contract` and `@unthrown/orpc` are peers for it) — so `sync`'s return
  is typed by the contract at the call. At runtime `implement(contract)` is
  walked next to the record (`routerOf`: a function leaf → `node.result(fn)`,
  an object → recurse, a key the implementer has no node for — reachable only
  past the types — dropped rather than defected on; `implement()` returns
  `undefined` for an undeclared key, measured), and `os.router(built)` is the
  port's service. `C` is bounded `Record<string, RouterContract>` — a router
  record, not a bare procedure, since a bare procedure has no keys to walk. The
  second call is di's `Provider(HttpRouterPort)(deps, { sync })` with the
  router built from what `sync` returns; there is no name to give. The
  return is `Provider<PortInstance<"HttpRouter", Router<…>>, never,
InstanceType<D[number]>> & { port: PortClassOf<"HttpRouter", Router<…>> }`,
  spelled through di's `PortInstance` / `PortClassOf` (`{ portId; new ():
PortInstance<…> }`) rather than the class's own type because a class
  expression's type expands the brand keys in a consumer's declaration emit
  (TS4023, measured on `examples/order-api`) — which is also why
  `HttpRouterPort` itself is a cast `Port("HttpRouter")` and not a `class`.
  `provider.port` stays on the result for a hand-declared provider or a type
  test. Only the `sync` arm: a router is built, not
  acquired. `HttpModule({ router: orderRouter })`, or `http()` next to
  `provides: [orderRouter]`, take it from there. Covered by the `rpc` fixture's
  `greetingRouter` (a bare-procedure `oc.router`, one nested) and the stray-key
  guard by `strayRouter` (the same implementation with an undeclared key,
  cast past the types).
- **`HttpRouter(contract)(controllers)` — the keyed form** (`orpc.ts`, a
  second overload of `build`) — for `contract: Record<string, RouterContract>`,
  a record keyed by the contract's own top-level keys, one
  `HttpController` per key, instead of `(deps, { sync })`. Typed
  `M extends { readonly [K in keyof C]: ControllerFor<C[K]> } & { readonly
[K in Exclude<keyof M, keyof C>]: never }` — the intersection's second half is
  what makes the form **exact**: a key `M` has that `C` does not declare types
  as `never` there, so the call fails to compile rather than silently
  dropping the key. `Array.isArray(depsOrControllers)` discriminates this arm
  from the positional one, the same way `Provider(port)(depsOrOptions, …)`
  discriminates its own two forms. `deps` for the underlying
  `Provider(HttpRouterPort)(...)` are the record's values' `.port`, in
  declaration order, so di builds every controller before the router; `sync`
  rebuilds the flat implementation record from what each controller's `sync`
  returned and hands it to the same `routerOf` walk the positional form uses.
  Five compile-time gates are pinned by `controller.test-d.ts`: every contract
  key covered, an undeclared key rejected, a controller under the wrong key
  rejected, a procedure a controller's fragment does not declare rejected
  inside the controller, and — the fifth, marked "do not break" — a fragment
  compiling as a contract in its own right, so `HttpRouter(contract.orders)([],
{ sync })` with the same shape as `ordersController`'s own `sync` still
  compiles: a slice lifts out of the composed router without its controller
  changing. Covered at runtime by the `rpcSliced` fixture, composing
  `helloController` and `echoesController` over `slicedContract`'s two
  fragments.
- **`HttpController(name, fragment)([deps], { sync })`** (`controller.ts`) —
  one slice of a contract, as a provider on a port minted for it. The first
  call fixes `fragment`'s type — read for its type only, so a procedure the
  fragment does not declare or a handler whose input or output has drifted is
  a compile error inside the controller rather than at the root — and mints
  `class extends Port(name)<Implementation<C>> {}`; the second is di's
  `Provider(port)(deps, { sync })`, unchanged. Returns
  `Provider<PortInstance<Name, Implementation<C>>, never,
InstanceType<D[number]>> & { readonly port: PortClassOf<Name, Implementation<C>> }` —
  the same `PortInstance`/`PortClassOf` spelling `HttpRouter` uses and for the
  same reason (TS4023 on a class expression's own type). The controller does
  no oRPC work: it is a plain record; `HttpRouter`'s `routerOf` walk is what
  wraps a leaf in `.result(...)`, at composition. A slice's module exports
  `controller.port` rather than naming a port of its own — the shape
  `Config.provider("RelayConfig")(schema)` already uses in this repo. Covered
  by `controller.spec.ts`'s `controllers` fixture (the port and declared deps
  a controller carries) and by every gate in `controller.test-d.ts` above.
- **`http({ prefix?, port?, hostname? })` →
  `Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort>`**
  — the starter, and **the one way HTTP is answered here: oRPC, over its own
  node adapter**. The
  former `@btravstack/orpc` was folded in for that reason — oRPC shares this
  stack's convictions (a contract, typed errors, `Result` at the boundary), so
  it is enforced, not offered among alternatives. The router is not an
  option: the module **needs** `HttpRouterPort`, and the application provides
  it — a provider that declares the use cases its procedures call (di injects
  them, oRPC's context stays empty), built by `HttpRouter(contract)(deps,
arm)`. The starter provides
  `Runtime<never, HttpInfo>` on the **`HttpRuntime`** port (a class over
  core's `RuntimePort`, **no `needs`**), which the composition root imports
  next to the application and exports so `start` finds it, and **`HttpConfig`**
  (`{ port, hostname }`) bound through `Config.provider` from `PORT` (default
  `3000`) and `HOST` (default `0.0.0.0` — a pod, not a laptop) in the kernel's
  `Env`. `port`/`hostname` **pin** a field instead of reading it — explicit >
  env > default, per field (`Config.pinned(value, field)` swaps the field's
  `parse` for a constant and keeps the variable name). A pinned field reads
  nothing from the environment; the declared `Env` need and `ConfigInvalid`
  stay whatever is pinned — one signature, no overload pair to keep in step
  (the kernel discharges the one, a pinned config never produces the other).
  `prefix` (default `/rpc`) is where the RPC endpoint is mounted. The worked
  example is `Module("OrderApi")({ imports: [Application, Persistence,
http()], provides: [orderRouter], exports:
[HttpRuntime] })` + `runMain(OrderApi)`; a test passes `env: { PORT: "0",
HOST: "127.0.0.1" }` to `start`. `HttpInfo` is `{ port }`, published on
  `Serving.info` once bound; `0` lets the OS pick, read back via
  `runtimeInfo()`.
- **Two gates, both compile-time.** `start`'s phantom rest tuple turns a
  composition exporting no `HttpRuntime` into an arity error (`NO RUNTIME`);
  and because the runtime provider depends on the router port **through di**,
  a composition that imports `http()` without providing the router
  carries `HttpRouterPort` as an unmet need `start` refuses — di's gate, not
  the kernel's.
  `examples/order-api/src/needs-gate.test-d.ts` pins both, plus the
  `StartOptions.unit` halves. There is no `UNSATISFIED RUNTIME NEEDS` case for
  this runtime any more: it declares none.
- **What it decides.** A procedure under `prefix` answers with its output or
  the `ORPCError` the router's `.result()` triage mapped its `Result` to
  (`@unthrown/orpc`, in the application — this package maps nothing); a defect
  inside a procedure is oRPC's own `INTERNAL_SERVER_ERROR` collapse; a path
  under `prefix` naming no procedure, and any path outside it, is declined
  unwritten by oRPC's adapter (`{ matched: false }`) and answered by the
  package's own `404`. The other two fallbacks — `500` when the listener
  failed before headers were out, socket destroyed once they were — are
  unreachable over the oRPC surface and exist because the transport is proven
  against a bare listener. A defect
  that never reaches the listener's promise — a synchronous throw, a
  `StartOptions.unit` provider failing to build — gets its `500` from the
  unit's `recoverDefect`, which destroys the socket only once headers are
  already out.
- **The guarantee**: the unit's lifetime **is** the response's — it does not
  close until the response's `'close'` event fires, and closes at once if that
  event already fired before the work ran (a client hanging up during a slow
  `StartOptions.unit` build; the unit's work is deferred behind the fork) — so
  there is no seam for a late write to land in, and `id: randomUUID()` is
  minted per request (a non-blank inbound `x-request-id` becomes `traceId`),
  so the two contracts a runtime owes are structural here rather than left to
  a caller's care.
- **Drain**: `stopAccepting` retires every open response — an unsent header
  gets `Connection: close`, a sent one ends its socket on `'finish'` — and
  `stop()` destroys what is still open. `closeIdleConnections()` alone would
  miss a response with a request in flight; that is why retirement is tracked
  per-response rather than left to it.
- **Not included, deliberately**: any other router or handler (there is no
  `handler` option and no listener port to provide — one way), middleware,
  `Result` → HTTP status, HTTPS, HTTP/2 — see the package README's _"What it
  does not do"_ for why each is a non-goal.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`,
  `@btravstack/di`, `unthrown`, `@orpc/server`, `@orpc/contract`,
  `@unthrown/orpc`. Hono and `@hono/node-server` were peers until the second
  code review of PR #40: Hono routed exactly one pattern (`${prefix}/*`) to
  oRPC's fetch adapter and 404'd the rest, which `@orpc/server/node`'s
  `RPCHandler.handle(req, res, { prefix })` plus the runtime's own `404` do
  with two dependencies fewer — and no `overrideGlobalObjects` footgun to
  disarm.

## Internal seam

- **`HttpHandler`** (`src/handler.ts`, **not** exported from `index.ts`) — a
  di `Port` whose service is the node listener,
  `(request, response, signal) => PromiseLike<unknown>`. `http()` provides it
  from the router port (`orpc.ts`'s `orpc({ prefix })`, a
  `Provider(HttpHandler)([HttpRouterPort], …)`: `@orpc/server/node`'s
  `RPCHandler`, `(request, response) => rpc.handle(request, response, {
prefix })`, unmatched → resolves unwritten), and the `HttpRuntime` provider depends on it through
  di. It returns `PromiseLike<unknown>` rather than `void` because the
  package must know when the listener is finished to write a `404` over a
  declined request without racing a response still in flight; `unknown`
  because oRPC's `handle` resolves `{ matched }`, never the unit's result.
- **`httpModule(options, handlerProvider)`** (`http-runtime.ts`, exported from
  the file, not from `index.ts`) — the runtime and its configuration as a
  module over whichever `HttpHandler` provider it is handed. `http()` is
  `httpModule(socket, orpc({ prefix }))`; the package's own transport
  specs hand it a bare listener instead. It exists for that second reason
  only. `httpRuntime`, the runtime value's factory, is internal too.
- **26 specs, 100% lines/functions.** Every app boots through the `boot`
  fixture — `@btravstack/testing`'s `bootFixture()`, which `serve`, `rpc`,
  `configured` and `appOnPort` depend on — so it is stopped when the test
  ends, on every exit path, and the teardown is Defect-only: a startup
  failure (`configured`'s `ConfigInvalid`, `occupied`'s port in use) is the
  test's to assert on `app.exited`. `http-runtime.spec.ts` carries 17,
  through `test-fixtures.ts`'s `appOf` — `httpModule({ port: 0, hostname:
"127.0.0.1" }, Provider(HttpHandler)({ value: handler }))` — so the
  guarantees (`404`/`500` fallbacks, the unit open until `'close'`, the drain,
  streamed responses, keep-alive retirement, the trace-id policy, port
  failures) are exercised with no router in the way; three of them are the
  starter's config (_"binds PORT and HOST from the environment when nothing is
  pinned"_, _"pins what it is given and reads the rest from the environment"_,
  _"fails startup with ConfigInvalid for HttpConfig when PORT is not a port"_,
  through the `configured` fixture, whose `BoundConfig` provider captures what
  the graph bound). `orpc.spec.ts` carries 7 the starter proper answers
  for, through the `rpc` fixture — `HttpModule("RpcApp")({ router:
greetingRouter, port: 0, hostname: "127.0.0.1", provides: [Greeter] })` over
  a router provider that declares a `Greeter`, with a typed `RPCLink` client:
  dependencies injected, a nested procedure, a stray implementation key
  dropped, `prefix` honoured, the runtime's 404 outside and under the prefix,
  and oRPC's `INTERNAL_SERVER_ERROR` collapse. `controller.spec.ts` carries the
  remaining 2, through the `controllers` and `rpcSliced` fixtures: a
  `HttpController` carries the port it was minted under and the deps it
  declared, and `HttpRouter(contract)({...})` serves a router composed from
  two controllers — `helloController` and `echoesController`, each over its
  own fragment of `slicedContract` — with a procedure from each answering
  through one client, proving every controller's slice was mounted under its
  own contract key. A process still serves one router (thesis #1); the keyed
  form changes how many providers build it, not that fact. `controller.test-d.ts`
  is the package's own compile-time gate — see Public surface.
