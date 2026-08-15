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
  `http({ router: provider.port })` to `imports`, prepends the provider to
  `provides` and `HttpRuntime` to `exports`, and hands the augmented tuples —
  `Imports<I, RouterInstance>` / `Provides<P, RouterInstance, RouterError,
RouterNeeds>`, readonly and exact — to di's own `Module(name)({...})`, whose
  return type IS the sugar's: nothing spelled twice. di exports `AnyModule`,
  `AnyProvider` and `Exportable` for exactly that (constraining the tuples the
  way `Module(name)` does); its other module-typing pieces stay internal.
  (Spelling the return through a named generic alias was tried and removed:
  declaration emit keeps such an alias unreduced and cannot name imported
  modules' internal ports — TS2883, measured.) `router` is a plain
  `Provider<RouterInstance, RouterError, RouterNeeds>` whose instance is
  constrained on the type parameter — `RouterInstance extends
PortInstance<string, Router<Record<never, never>>>` — so a provider of
  anything but a context-free oRPC router fails at the call; the port class is
  read off `provider.port` for the delegation (`as never` — the check already
  happened one level up). Covered by the package's own `rpc` fixture, which
  composes `RpcApp` through it. Options `port`/`hostname` pin as for `http()`.
- **`HttpRouter(contract)(name)(deps, { sync })`** (`orpc.ts`) — contract-first
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
  record, not a bare procedure, since a bare procedure has no keys to walk. The port
  is minted `class extends Port(name)<Router<Record<never, never>>> {}` and
  cast to di's **`PortClassOf<Name, Router<…>>`** (`{ portId: Name; new ():
PortInstance<Name, Router<…>> }` — the one nameable spelling of a minted port
  class; the class expression's own type expands the brand keys in declaration
  emit, TS4023 measured); the return is `Provider<PortInstance<Name,
Router<…>>, never, InstanceType<D[number]>> & { port: PortClassOf<Name,
Router<…>> }`, spelled explicitly for the same reason. Only the `sync` arm: a router is built, not
  acquired. `HttpModule({ router: orderRouter })` / `http({ router:
orderRouter.port })` take it from there. Covered by the `rpc` fixture's
  `greetingRouter` (a bare-procedure `oc.router`, one nested) and the stray-key
  guard by `strayRouter` (the same implementation with an undeclared key,
  cast past the types).
- **`http({ router, prefix?, port?, hostname? })` →
  `Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | InstanceType<RouterPort>>`**
  — the starter, and **the one way HTTP is answered here: oRPC, over its own
  node adapter**. The
  former `@btravstack/orpc` was folded in for that reason — oRPC shares this
  stack's convictions (a contract, typed errors, `Result` at the boundary), so
  it is enforced, not offered among alternatives. `router` is the
  application's **router port**: a class over di's `Port` whose service is a
  context-free oRPC router, provided by the application (a provider that
  declares the use cases its procedures call — di injects them, oRPC's context
  stays empty). It is constrained at the call site as `R & RouterPort<R>`
  (`orpc.ts`): a port whose service `RPCHandler` cannot serve with no initial
  context fails to typecheck there. The starter provides
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
http({ router: OrderRouter })], provides: [orderRouter], exports:
[HttpRuntime] })` + `runMain(OrderApi)`; a test passes `env: { PORT: "0",
HOST: "127.0.0.1" }` to `start`. `HttpInfo` is `{ port }`, published on
  `Serving.info` once bound; `0` lets the OS pick, read back via
  `runtimeInfo()`.
- **Two gates, both compile-time.** `start`'s phantom rest tuple turns a
  composition exporting no `HttpRuntime` into an arity error (`NO RUNTIME`);
  and because the runtime provider depends on the router port **through di**,
  a composition that imports `http({ router })` without providing the router
  carries an unmet need `start` refuses — di's gate, not the kernel's.
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
  a caller's care. `getRequestListener` runs with `overrideGlobalObjects:
false`, so `globalThis.Request`/`Response` are left alone.
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
  from the router (`orpc.ts`'s `orpc(router, { prefix })`: `@orpc/server/node`'s
  `RPCHandler`, `(request, response) => rpc.handle(request, response, {
prefix })`, unmatched → resolves unwritten), and the `HttpRuntime` provider depends on it through
  di. It returns `PromiseLike<unknown>` rather than `void` because the
  package must know when the listener is finished to write a `404` over a
  declined request without racing a response still in flight; `unknown`
  because oRPC's `handle` resolves `{ matched }`, never the unit's result.
- **`httpModule(options, handlerProvider)`** (`http-runtime.ts`, exported from
  the file, not from `index.ts`) — the runtime and its configuration as a
  module over whichever `HttpHandler` provider it is handed. `http()` is
  `httpModule(socket, orpc(router, prefix))`; the package's own transport
  specs hand it a bare listener instead. It exists for that second reason
  only. `httpRuntime`, the runtime value's factory, is internal too.
- **24 specs, 100% lines/functions.** `http-runtime.spec.ts` carries 17,
  through `test-fixtures.ts`'s `appOf` — `httpModule({ port: 0, hostname:
"127.0.0.1" }, Provider(HttpHandler)({ value: handler }))` — so the
  guarantees (`404`/`500` fallbacks, the unit open until `'close'`, the drain,
  streamed responses, keep-alive retirement, the trace-id policy, port
  failures) are exercised with no router in the way; three of them are the
  starter's config (_"binds PORT and HOST from the environment when nothing is
  pinned"_, _"pins what it is given and reads the rest from the environment"_,
  _"fails startup with ConfigInvalid for HttpConfig when PORT is not a port"_,
  through the `configured` fixture, whose `BoundConfig` provider captures what
  the graph bound). `orpc.spec.ts` carries the 7 the starter proper answers
  for, through the `rpc` fixture — `HttpModule("RpcApp")({ router:
greetingRouter, port: 0, hostname: "127.0.0.1", provides: [Greeter] })` over
  a router provider that declares a `Greeter`, with a typed `RPCLink` client:
  dependencies injected, a nested procedure, a stray implementation key
  dropped, `prefix` honoured, the runtime's 404 outside and under the prefix,
  and oRPC's `INTERNAL_SERVER_ERROR` collapse.
