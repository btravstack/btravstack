# packages/http-server

The HTTP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/http-server/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`HttpModule(name)({ router, prefix?, port?, hostname?, plugins?, securityHeaders?, imports?, provides?, exports?, needs? })`**
  (`http-module.ts`) — THE way an application declares an HTTP deployment:
  `Module(name)({...})` plus the router **provider**. It appends
  `http({ prefix?, port?, hostname? })` to `imports`, prepends the provider to
  `provides` and `HttpRuntime` to `exports`, and hands the augmented tuples —
  `Imports<I>` / `Provides<P, RouterError, RouterNeeds, Auth>`, readonly and exact
  — to di's own `Module(name)({...})`, whose
  return type IS the sugar's: nothing spelled twice. di exports `AnyModule`,
  `AnyProvider` and `Exportable` for exactly that (constraining the tuples the
  way `Module(name)` does); its other module-typing pieces stay internal.
  (Spelling the return through a named generic alias was tried and removed:
  declaration emit keeps such an alias unreduced and cannot name imported
  modules' internal ports — TS2883, measured.) `router` is
  `Provider<HttpRouterPort, RouterError, RouterNeeds>` — a provider on the
  starter's own router port, which is what `api.HttpRouter(contract)(deps, arm)`
  returns — so a provider of anything else fails at the call, and there is no
  port to read off it: the starter needs `HttpRouterPort`, and the sugar's
  job is to provide it. Covered by the package's own `rpc` fixture, which
  composes `RpcApp` through it. Options `port`/`hostname` pin as for `http()`.
  **There is no `authenticator` option.** The router provider carries
  `readonly authenticators: readonly Auth[]` — the per-scheme providers
  `defineHttp` bound — and the sugar spreads them into `provides` itself, so
  an application never lists one and cannot list the wrong one. `Auth` is
  inferred from the router, and `Provides` is
  `readonly (Provider<HttpRouterPort, …> | Auth | P[number])[]` — a
  union-element **array**, not a tuple, and that is forced: `Auth` is one type
  per scheme, so with two schemes it arrives as a union and a tuple takes one
  rest element, not two. Nothing downstream wants the arity — di reads
  `P[number]` throughout — and putting the authenticators in `provides` is what
  carries **their own needs** (a `JwtVerifier`, a key set) into `NeedsGate`, so
  a root that satisfies none is refused at THIS call exactly as a hand-listed
  provider would be (`auth.test-d.ts`'s arms 11 and 12). A scheme the contract
  names that the registry has no authenticator for is di's own unmet need on
  `HttpAuthenticator:<scheme>`, not a gate this package writes — and the
  identity comparison the old `authenticator` option performed is gone with it,
  since declaring a scheme and implementing it are now the same act.
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
- **`api.HttpRouter(contract)(deps, { sync })`** (`orpc.ts`, minted by
  `defineHttp`) — contract-first
  router provider. `Implementation<C, Schemes>` is the record type: recursing the
  contract's shape, each `ProcedureContract<I, O, E>` becomes
  `Parameters<ProcedureImplementer<DefaultInitialContext & object, ContextOf<C, R, Schemes>,
I, O, E>["result"]>[0]` — the `.result()` handler `@unthrown/orpc` gives that
  procedure's implementer (`import "@unthrown/orpc/extensions/result"` here;
  `@orpc/contract` and `@unthrown/orpc` are peers for it) — so `sync`'s return
  is typed by the contract at the call. At runtime `implement(contract)` is
  walked next to the record (`routerOf`: a function leaf → `node.result(fn)`,
  an object → recurse, a key the implementer has no node for — reachable only
  past the types — dropped rather than defected on; `implement()` returns
  `undefined` for an undeclared key, measured), and `os.router(built)` is the
  port's service. `C` is bounded `Record<string, RouterContract>` — a router
  record, not a bare procedure, since a bare procedure has no keys to walk. The
  second call is di's `Provider(HttpRouterPort)({ name: Dep }, { sync })` with the
  router built from what `sync` returns; there is no name to give. The
  return is `Provider<PortInstance<"HttpRouter", Router<…>>, never,
InstanceType<D[keyof D]>> & { port: PortClassOf<"HttpRouter", Router<…>> }`,
  spelled through di's `PortInstance` / `PortClassOf` (`{ portId; new ():
PortInstance<…> }`) rather than the class's own type because a class
  expression's type expands the brand keys in a consumer's declaration emit
  (TS4023, measured on `examples/order-api`) — which is also why
  `HttpRouterPort` itself is a cast `Port("HttpRouter")` and not a `class`.
  `provider.port` stays on the result for a hand-declared provider or a type
  test, and `provider.authenticators` carries the per-scheme providers
  `defineHttp` bound — on the router because the router is what needs them.
  Only the `sync` arm: a router is built, not
  acquired. `HttpModule({ router: orderRouter })`, or `http()` next to
  `provides: [orderRouter]`, take it from there. Covered by the `rpc` fixture's
  `greetingRouter` (a bare-procedure `oc.router`, one nested) and the stray-key
  guard by `strayRouter` (the same implementation with an undeclared key,
  cast past the types).
- **`api.HttpRouter(contract)([piece, …])` — the composing form** (`orpc.ts`, a
  third overload of `build`, declared **last**) — for
  `contract: Record<string, RouterContract>`, an **array of pieces** instead of
  `(deps, { sync })`, each an `HttpController(contract, path)` over one node
  of the contract tree, at any depth — the same shape as
  `AmqpHandlers(contract)([...])` and `TemporalActivities(contract)([...])`,
  with the paths as HTTP's extra degree of freedom. Coverage is **leaf-based**:
  the paths must partition the contract's PROCEDURES (`LeafPathsOf`, each leaf
  covered when it sits at or under a piece's path — `CoveredBy`), so any mix
  of depths composes — `[v1Orders, v1Customers, health]` and `[v1, health]`
  alike. An uncovered leaf is refused against the
  `"UNCOVERED CONTROLLERS — the contract declares a procedure this array does
not cover"` marker, and what the marker names is a procedure path
  (`"v1.customers.find"`), not a fragment. Declared last is load-bearing
  (measured in `packages/amqp-worker`, same mechanism): TypeScript reports the
  last overload's failure, so a non-covering array fails against the marker
  rather than degrading to di's `Qualification`, which names nothing; the
  marker is a **sentence** because it is the only actionable part of the
  diagnostic and it prints last, past the caller's own wide piece type. The
  missing leaf itself is named only when the array's length matches the marker
  tuple's own length of 2, as a separate diagnostic on the trailing element
  whose target is the bare path.
  A **second gate** rides the same overload: `Overlapping<Paths>` — a piece
  path nested inside another piece's path
  (`Overlapping<"v1" | "v1.orders" | "health">` is `"v1.orders"`), refused
  against
  `"OVERLAPPING CONTROLLERS — a piece sits inside another piece's fragment"`.
  It must exist because the two pieces would implement the same procedures on
  **two distinct port ids** — unlike two pieces at ONE path, which share an id
  and are di's duplicate-provider defect — so di cannot see them conflicting,
  and the `nest` rebuild below would silently let one win. This gate is the
  only thing standing between a dotted path and that silent overwrite.
  `Uncovered` reads each piece's path by stripping `CONTROLLER_PREFIX` back
  off its port id (`KeyOfPiece`), so the path is never spelled twice; and
  `PieceOf`'s port type is spelled **inline**, not as
  `ControllerPortOf<C, K, Schemes>` — a regression guard against a hole that
  held only on #116's flat `ControllerKeyOf`; on the current recursive-path
  shape both spellings refuse the marked-piece-under-unmarked-contract
  direction (re-measured 2026-08-25, same TS version as #116). Kept anyway
  because the alias route rides a compiler heuristic that has already changed
  behaviour across one key-shape refactor — see `PieceOf`'s own TSDoc. At
  runtime `Array.isArray`
  alone identifies this arm — an array is never a valid `(deps, arm)` or
  `(arm)` call — so the retired keyed record's three-form
  `sync`-holds-a-function discrimination is gone, and the remaining
  `(deps, arm)` / `(arm)` pair is settled by plain arity as everywhere else
  (the arm-only `sync` is still handed **no** arguments, pinned by
  `controller.spec.ts`). The composed provider's `deps` are the piece
  **ports**, keyed by the very dotted path each port id carries — so di
  builds every piece before the router, and `nest` folds the flat path-keyed
  services record back into the nesting the contract already has before
  `routerFrom`: `routerOf` walks the same tree it always did, marks,
  inheritance and the stray-key drop included. The walk itself is untouched —
  `nest` lives in the composing arm because the walk is shared with the
  `(deps, arm)` form, which never nests. The pieces themselves still need
  discharging — listed in `provides` alongside the router, or exported by a
  slice module imported in — exactly as in `packages/amqp-worker`. Coverage
  is not uniqueness, but with paths the split moved: a piece **inside**
  another piece's fragment is caught at the call (the
  `OVERLAPPING CONTROLLERS` gate above), while two pieces at the **same**
  path remain one port id and therefore di's duplicate-provider defect — and
  only when **both** end up discharged as providers in the same graph; wire
  in only one and the other's implementation is simply never registered, no
  diagnostic marking the conflict.
  **A literal dot in a contract key is refused, at both ends** (issue #121,
  where it was a green compile and a 404): `nest` rebuilds a piece's path by
  splitting on `.`, so it cannot tell a path separator from a dot inside one
  key. `ControllerKeyOf` therefore drops dotted keys at **every** level, so
  no port can carry one — but the **mint** is constrained by `AnyKeyOf`, the
  same walk without the refusal, with `SliceableGate<C, K>` intersected onto
  `key` the way `ScopeGate` rides `contract`. That is the difference between
  a diagnostic that says why and one that misleads: constraining `key` by
  `ControllerKeyOf` refuses `"a.b"` too, but as
  `not assignable to parameter of type '"plain"'` — a typo hint pointing at
  the wrong problem. The gate binds the bad path instead and names it in a
  sentence. On the array, `Unsliceable<C>` refuses a contract whose **top**
  level carries one, against `"UNSLICEABLE CONTRACT KEY — …"` reported ahead
  of `Uncovered`, because "no piece can name this" is a different fact from
  "no piece did" and only the first says the array form is the wrong tool.
  Both sentences point at the `(deps, arm)` form, which splits nothing and
  serves such a contract correctly. Only the **top** level is fatal: a piece
  at a dotted key's parent hands its implementation record to `routerOf`
  whole, and that walk splits paths, never the keys underneath them — so
  `{ v1: { "a.b": oc } }` still composes from a piece at `"v1"`, and the gate
  must not over-reach onto it.
  The return is the same `Built<Auth, N>` as the other arms, with
  `N = InstanceType<T[number]["port"]> | SchemePortsOf<C>`.
  Six compile-time gates are pinned by `controller.test-d.ts`: every
  procedure covered (the marker above); an undeclared path refused **at the
  mint** (`HttpController(contract, "billing")` and `(deep, "v1.billing")`
  have nothing to type the key by — the keyed record's `"UNDECLARED KEY — …"`
  gate collapsed into it); a piece under the wrong key impossible **by
  construction** (its path rides its port id, so what that gate refused is
  now an array leaving a leaf uncovered — the same marker, pinned as its own
  arm); a procedure the fragment does not declare rejected inside the piece;
  and — the fifth, marked "do not break" — a slice lifting out of the
  composed router **with its piece unchanged**:
  `api.HttpRouter(contract.orders)({ implementation: ordersPiece.port }, { sync: ({ implementation }) => implementation })`
  compiles, so the lifted root declares the very provider the modulith
  composed and hands back what it built; and the sixth, a top-level key
  carrying a literal dot, refused at the mint and again at the array. The
  gate names the piece
  deliberately — a fresh `sync` literal over the fragment would pin only that
  a fragment is a valid contract, the weaker half, which says nothing about
  the piece surviving the lift. All five are pinned **twice**: once against a
  plain contract and once against one whose `orders` fragment is
  `authenticated({ user: [] })(...)`, so the marker's phantom key cannot
  quietly break any of them — the fifth least of all. The same block pins the
  one direction that must be refused: a piece whose handler reads
  `opts.context.principal` cannot be composed under the **unmarked**
  contract, where nothing would inject one (the arm the inline `PieceOf`
  spelling exists to keep firing). The reverse is accepted and correctly so —
  a piece over an unmarked fragment inside a contract that marks another is a
  handler that ignores the principal, which is contravariantly fine.
  Three further arms pin what the requirements themselves do: a procedure
  under a marked record inherits that record's requirement, a procedure with
  its own mark **replaces** it rather than adding to it, and the router's needs
  channel carries one `HttpAuthenticator:<scheme>` port per scheme the contract
  names anywhere — two schemes, one scheme, and none at all, each asserted in
  **both** directions, since a one-way check passes on a collapsed `never`.
  The depth block at the file's tail pins the dotted paths themselves: pieces
  at mixed depths partitioning the leaves compose, an uncovered procedure and
  a nested piece are each refused against their marker, and the port id
  carries the whole path (`"HttpController:v1.orders"`).
  Covered at runtime by the `rpcSliced` fixture — `helloController` over
  `slicedContract`'s `greetings` fragment and `echoesController` minted by
  the DOTTED path `"echoes.ping"`, so `nest`'s rebuild answers a real
  request — and by `rpcDeep`, two pieces sharing the nested `"v1"` parent
  plus one at the bare procedure path `"health"`.
- **`api.HttpController(contract, key)({ name: Dep }, { sync })`, or
  `({ sync })` with no deps** (`controller.ts`, minted by `defineHttp`) — one
  node of a contract, at any depth, as a provider on a port of its own. There
  is no name to give: the dotted path IS the port's name, minted as
  `` `${CONTROLLER_PREFIX}${key}` `` (`CONTROLLER_PREFIX = "HttpController:"`,
  exported from `controller.ts` only) — the move `AmqpHandler(contract, key)`
  and `authenticatorPort(scheme)` both make. The port id carrying the path is
  what makes two slices claiming one node di's duplicate-provider defect
  rather than a silent merge, and what lets the composing form recover each
  piece's path without it being spelled again. The first call fixes the
  contract's type — read for its **type** only, so a path the contract does
  not declare is refused at the call (`ControllerKeyOf<C>`, the union of
  **every path** into the contract tree — a fragment or a procedure, dotted
  at each level, less the marker's phantom key; the former top-level keys are
  its depth-1 subset). Two guards inside are measured, not stylistic: an
  index-signature record short-circuits to `string` — that shape is only ever
  a GENERIC's constraint (`RouterContract` is recursive), and recursing over
  `string` keys was TS2589 at every generic declaration whose constraint
  mentions the type — and `Implementation`'s first parameter is **unbounded**
  for the sibling reason: it is instantiated with the deferred
  `FragmentAt<C, K>`, whose branches TypeScript cannot prove `RouterContract`
  for a generic contract, while the mapped arm already guards each child with
  `C[K] extends RouterContract`. A procedure the fragment does not declare or
  a handler whose input or output has drifted is a compile error inside the
  piece rather than at the root. The fragment's type is `FragmentAt<C, K>`,
  applied **at the mint**: it folds `Effective` down the path — nearest mark
  wins at each level, exactly the step `routerOf`'s `inherited` argument
  takes at runtime, so the types and the walk cannot part — and ends on
  `Inherit<node, folded>`, which is how a marked ancestor types
  `context.principal` in a piece minted from below it — the check the retired
  keyed form performed at the root, now performed where the handler is
  written. The second call is di's `Provider(port)({ name: Dep }, { sync })`,
  unchanged — **including its no-deps arm**, mirrored by arity for the same
  reason di has one: a piece that calls no use case is the common shape here,
  not an edge case, and `({}, { sync })` is what it would otherwise spell.
  Returns
  `Provider<InstanceType<ControllerPortOf<C, K, Schemes>>, never, N> & { readonly port: ControllerPortOf<C, K, Schemes> }` —
  `ControllerPortOf<C, K, Schemes>` being `PortClassOf` over the prefixed
  path and `Implementation<FragmentAt<C, K>, Schemes>`, the same
  `PortInstance`/`PortClassOf` spelling `HttpRouter` uses and for the same
  reason (TS4023 on a class expression's own type). `ControllerKeyOf<C>` and
  `ControllerPortOf<C, K, Schemes>` are **types**, exported from `index.ts`
  for the same declaration-emit reason `@btravstack/amqp-worker` exports
  `HandlerPortOf<C, K>`: a slice module that exports its piece by name needs
  the port type printable. The piece does no oRPC work: it is a plain record;
  `HttpRouter`'s `routerOf` walk is what wraps a leaf in `.result(...)`, at
  composition. A slice's module exports `controller.port` rather than naming
  a port of its own — the shape `Config.provider("RelayConfig")(schema)`
  already uses in this repo. Covered by `controller.spec.ts`'s `controllers`
  fixture (the key-minted port and declared deps a piece carries) and by
  every gate in `controller.test-d.ts` above. `controller.ts` imports
  `Effective`/`Implementation`/`Inherit` from `orpc.ts` with `import type` —
  erased by `verbatimModuleSyntax` — while `orpc.ts` imports
  `CONTROLLER_PREFIX` from `controller.ts` as a value, so the two files
  reference each other in the type graph with **no runtime cycle**, the same
  arrangement `packages/amqp-worker` documents between `handler.ts` and
  `amqp-runtime.ts`.
- **Authentication — the contract marker, `Principal`/`SchemesOf`,
  `HttpAuthenticator`, `defineHttp`, `principalMiddleware`, the scope rule and
  the scheme-dependency wiring — is stated in full in `AUTH.md`.** Read it
  before changing `auth.ts`, `principal.ts`, `define-http.ts` or the contract
  marker. In short: the contract says WHICH SCHEMES protect a route and which
  scopes each must grant, `defineHttp({ authenticators })` says WHAT each
  scheme resolves to, and an unmarked procedure is public with nothing failing
  if the marker is forgotten.

- **`http({ prefix?, port?, hostname?, plugins?, securityHeaders? })` →
  `Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort>`**
  — the starter, and **the one way HTTP is answered here: oRPC, over its own
  node adapter**. The
  former `@btravstack/orpc` was folded in for that reason — oRPC shares this
  stack's convictions (a contract, typed errors, `Result` at the boundary), so
  it is enforced, not offered among alternatives. The router is not an
  option: the module **needs** `HttpRouterPort`, and the application provides
  it — a provider that declares the use cases its procedures call (di injects
  them, oRPC's context stays empty), built by `api.HttpRouter(contract)(deps,
arm)`. The starter provides
  `Runtime<never, HttpInfo>` on the **`HttpRuntime`** port (a class over
  core's `RuntimePort`, **an empty `resolves`**), which the composition root imports
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
  `runtimeInfo()`. **`plugins`** —
  `readonly NodeHttpHandlerPlugin<DefaultInitialContext>[]`, from
  `@orpc/server/node` — forwards straight to `new RPCHandler(service, {
plugins })`: CORS, body limits, compression, CSRF are transport policy oRPC
  already expresses as handler plugins, so the ordinary use is configuration
  rather than a middleware slot for application logic. It threads through all three surfaces on the same
  `...(x === undefined ? {} : { x })` spread every other option here uses —
  `OrpcOptions.plugins` (`orpc.ts`) → `HttpOptions.plugins` (`http-runtime.ts`)
  → `HttpModuleOptions.plugins` (`http-module.ts`) — and needs no generic
  parameter on any of the three, since it is a plain optional field like
  `prefix`. It is an **honest escape hatch, not a keyhole**: oRPC's
  `StandardHandlerPlugin.init` transforms handler options **including
  `StandardHandlerOptions.interceptors`**, so a plugin can wrap execution and
  an application determined to see a procedure's outcome can get there. What
  the option buys is that the ordinary path is visible configuration at the
  composition root rather than a middleware slot for application logic —
  which is the one thing thesis #3 and the "Not included" bullet below still
  refuse, and reaching past it is a visible act rather than the default shape.
  `principalMiddleware` (see `AUTH.md`) is the one per-request hook this package
  itself installs, and only on a marked leaf.
- **`securityHeaders`** — `boolean | Readonly<Record<string, string>>`,
  default `true`. **Not** routed through `orpc()`: it stays on `HttpOptions`
  after `prefix` and `plugins` are destructured out of `http()`'s options, so
  it lands in `socket` — the rest handed to `httpModule` — and is applied by
  `http-runtime.ts`'s `listen`, on the raw node listener, **before**
  dispatch. That placement, not an oRPC plugin, is deliberate: a plugin only
  runs for a request oRPC **matched**, so the runtime's own `404` and `500`
  would go out bare — the opposite of what helmet-style headers are for.
  `true` applies the package's small default set
  (`x-content-type-options: nosniff`, `x-frame-options: DENY`,
  `referrer-policy: no-referrer`); `false` disables the feature; a record
  replaces the defaults outright. Resolved once per `listen` call, outside
  the per-request `createServer` callback, and set as its **first**
  statement — before `open.add(response)` — so it covers a served response,
  the runtime's `404`, its `500`, and a drained/retired response alike.
  `HttpModuleOptions.securityHeaders` (`http-module.ts`) forwards it to
  `http()` on the same `...(x === undefined ? {} : { x })` spread every
  other option here uses.
- **Two gates, both compile-time, and they are different mechanisms.**
  `start`'s phantom marker — intersected onto `module` — turns
  a composition exporting no `HttpRuntime` into a `TS2345` whose last line is
  `"NO RUNTIME — the module exports no port declared over RuntimePort"`; and
  because the runtime provider depends on the router port **through di**,
  a composition that imports `http()` without providing the router
  carries `HttpRouterPort` as an unmet need `start` refuses on the same
  parameter's `Module<X, E, Scope | Env>` half, ending on
  `Type '"HttpRouter"' is not assignable to type '"@di/Scope"'`. Neither is
  di's `UNSATISFIED DEPENDENCIES` dependency gate.
  `examples/order-api/src/needs-gate.test-d.ts` pins both, plus the
  `StartOptions.unit` halves. There is no `UNSATISFIED RUNTIME PORTS` case for
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
  `handler` option and no listener port to provide — one way), a middleware
  slot for application logic, `Result` → HTTP status, HTTPS, HTTP/2 — see the
  package README's _"What it does not do"_ for why each is a non-goal.
  `plugins` (above) is an honest escape hatch rather than a keyhole — a plugin
  can reach `StandardHandlerOptions.interceptors` and therefore a procedure's
  execution — but the ordinary path is visible configuration at the
  composition root, and an application middleware acting on the handler's
  `Result` is what stays refused.
- Peer dependencies: `@btravstack/core`, `@btravstack/config`,
  `@btravstack/di`, `@btravstack/contract`, `unthrown`, `@orpc/server`,
  `@orpc/contract`, `@unthrown/orpc`. `@btravstack/contract` is a peer for the
  same dual-copy reason as the rest: its marker is a `unique symbol` and two
  copies of the package are two different symbols, so a contract marked
  against one would read as unmarked here. Hono and `@hono/node-server` were peers until the second
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
  `Provider(HttpHandler)({ router: HttpRouterPort }, …)`: `@orpc/server/node`'s
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
- **57 specs, 100% lines/functions.** Every app boots through the `boot`
  fixture — `@btravstack/testing`'s `bootFixture()`, which `serve`, `rpc`,
  `configured` and `appOnPort` depend on — so it is stopped when the test
  ends, on every exit path, and the teardown is Defect-only: a startup
  failure (`configured`'s `ConfigInvalid`, `occupied`'s port in use) is the
  test's to assert on `app.exited`. `http-runtime.spec.ts` carries 23,
  through `test-fixtures.ts`'s `appOf` — `httpModule({ port: 0, hostname:
"127.0.0.1" }, Provider(HttpHandler)({ value: handler }))` — so the
  guarantees (`404`/`500` fallbacks, the unit open until `'close'`, the drain,
  streamed responses, keep-alive retirement, the trace-id policy, port
  failures) are exercised with no router in the way; three of them are the
  starter's config (_"binds PORT and HOST from the environment when nothing is
  pinned"_, _"pins what it is given and reads the rest from the environment"_,
  _"fails startup with ConfigInvalid for HttpConfig when PORT is not a port"_,
  through the `configured` fixture, whose `BoundConfig` provider captures what
  the graph bound), and four of them are `securityHeaders`: the defaults on a
  served response through `serve`, the same defaults on the runtime's own
  `404` through `rpc` — the path a handler plugin would never reach — their
  absence when `securityHeaders: false` is pinned, and a **custom record**
  applied verbatim (the given headers on the response and the defaults gone,
  since the record replaces them rather than extending them), `serve`'s third
  argument threading straight into `appOf`. `orpc.spec.ts` carries 8 the starter proper answers
  for, through the `rpc` fixture — `HttpModule("RpcApp")({ router:
greetingRouter, port: 0, hostname: "127.0.0.1", provides: [Greeter] })` over
  a router provider that declares a `Greeter`, with a typed `RPCLink` client:
  dependencies injected, a nested procedure, a stray implementation key
  dropped, `prefix` honoured, the runtime's 404 outside and under the prefix,
  and oRPC's `INTERNAL_SERVER_ERROR` collapse — plus one through `rpcWithCors`,
  a `greet`-only router configured with oRPC's own `CORSHandlerPlugin`, proving
  `plugins` reaches `RPCHandler` rather than being silently accepted and
  dropped: the plugin, not this package, decided the response's
  `access-control-allow-origin`. `controller.spec.ts` carries 6, through the
  `controllers`, `rpcSliced` and `rpcDeep` fixtures: a piece carries the port
  its contract key minted (`HttpController:greetings`) and the deps it
  declared; `api.HttpRouter(contract)([...])` serves a router composed from
  two pieces — `helloController` over the `greetings` fragment and
  `echoesController` minted by the dotted path `"echoes.ping"` — with a
  procedure from each answering through one client, proving every piece's
  slice was mounted under the path its port id carries, `nest`'s rebuild
  included; one pins that an arm-only router's `sync` is handed **no
  arguments** at all (the former sync-key discrimination spec is deleted with
  the record form: there is no record for a `sync` key to be confused with,
  `Array.isArray` decides); and two are `rpcDeep`, over a contract with two
  pieces sharing the nested `"v1"` parent (`"v1.orders"` and
  `"v1.customers"`) plus one minted at the bare procedure path `"health"` —
  the shared parent is what forces `nest`'s `node[segment] ??=` to find a
  node the first piece already created rather than only ever creating one,
  and `"health"` is the depth-N leaf case, a piece with no fragment around it
  at all. A sixth pins that the rebuild reaches **no prototype**: `nest` builds
  with `Object.create(null)`, because on a plain `{}` a `"__proto__"` segment
  reads `Object.prototype` — not nullish, so `??=` assigns nothing — and the
  walk then writes the piece onto `Object.prototype` itself, corrupting every
  object in the process (measured). `routerOf` only ever `Object.entries` what
  it is handed, so nothing downstream wants the prototype.
  A process still serves one router (thesis #1); the composing
  form changes how many providers build it, not that fact. `auth.spec.ts`
  carries the last 20, through the `rpcAuthed`, `rpcRootMarked`,
  `rpcRootMarkedDeep`, `controllers` and `headers` fixtures — every router, controller and
  authenticator in them minted by ONE `defineHttp({ authenticators })`,
  since a contract naming no principal leaves the factory as the only way a
  handler gets a readable one. Four are over
  `authedContract` — `{ orders: authenticated({ user: [] })({ whoami }), health: { ping } }`,
  one protected fragment and one public one: the handler reading a `userId`
  only the factory typed, a rejected token answering `UNAUTHORIZED` with the
  handler never entered, an authenticator's own defect collapsing to
  `INTERNAL_SERVER_ERROR` rather than a 401, and an unmarked procedure served
  with no credentials at all. One more is over the authenticator that
  **declares a dependency** — a `Verifier` port, the arm `defineHttp` binds
  through `Provider(port)(deps, arm)` — proving its need travelled with it into
  the graph, and one more is `rpcSubstituted` — the same router with the
  scheme's authenticator replaced on its port, the substitution seam
  `authenticatorPort` exists for. Two are over `rootMarkedContract` —
  `authenticated({ user: [] })({ orders: { whoami } })`, the mark on the **root**, where
  there is no `contract[key]` to read it from: every leaf beneath it is
  protected, and an accepted caller still reaches the
  handler with its principal. Two more are over `rootMarkedDeepContract` — the
  same root mark served through a piece minted **two levels below it**
  (`"v1.orders"`) — the fold-vs-walk proof: an accepted caller reaches the
  piece with its principal and a refused one never enters it, evidence that
  `FragmentAt`'s compile-time fold (applied where the piece is minted) and
  `routerOf`'s runtime `inherited` walk (seeded from the router's own root,
  regardless of how many pieces compose it) type and protect the same leaf.
  Two are composition-time — the scheme's own port
  declared alongside the dependencies the caller wrote, and no scheme port at
  all when the contract marks nothing. The last eight drive
  `principalMiddleware` directly, over the `headers` fixture, and are where the
  feature's own rules are pinned: the first requirement a caller satisfies
  wins, `UNAUTHORIZED` when none is, a granted scope admits, a bare identity
  carrying a `scopes` field injected whole rather than mistaken for a scoped
  grant, `FORBIDDEN` when
  the scheme grants no scopes at all, `FORBIDDEN` when the credential is valid
  but under-scoped, the principal tagged when **one** requirement names two
  schemes, and a defect stopping the walk instead of falling through to the
  next requirement.
  `controller.test-d.ts` is the package's own compile-time gate — see Public
  surface.

## Cross-cutting concerns: configuration, not a middleware slot

CORS, body limits, compression, CSRF, security headers and authentication all
arrive at the same door, and the answer is the same for all of them: **they are
handler configuration, not a middleware slot.** Thesis #3's refusal survives
intact, narrowed to what it was always about. An oRPC plugin and the starter's
own `principalMiddleware` act on the **request/response envelope** — bytes,
headers, a principal resolved before dispatch. An application middleware would
act on the handler's **`Result`**, and that is the only one `@btravstack/http-server`
refuses, because it is the one that would put a use case's outcome in the
transport's hands.

- **`plugins` is an honest escape hatch, not a keyhole.** It forwards straight
  to `new RPCHandler(service, { plugins })`, and an oRPC plugin can reach
  oRPC's interceptors — so an application determined to see a procedure's
  outcome can get there. Nothing pretends otherwise. What the option buys is
  that the ordinary path is configuration a reader can see at the composition
  root, and reaching past it is a visible act rather than the default shape.
- **Security headers are set on the listener, not as a plugin.** A plugin only
  runs for a request oRPC **matched**, so the runtime's own `404` would go out
  bare — the opposite of what helmet-style headers are for.
- **Rate limiting is a stated non-goal.** A per-process counter is the wrong
  unit: an `api` deployment is N pods (thesis #1), so a per-process budget is
  N independent budgets and none of them is the limit anybody meant. The
  ingress or gateway is where a request count is counted once. An application
  that wants one anyway writes a plugin and passes it through `plugins` —
  which is the escape hatch doing its job, not a gap.
- **An unmarked procedure is public, and nothing fails if the marker is
  forgotten.** `@btravstack/contract`'s marker makes the requirement
  **legible** in the contract and makes the principal's type reach the
  handler; it does not detect a procedure that should have been marked. There
  is no gate for "you forgot", and there cannot be one — the contract is the
  only statement of intent there is. Do not describe an unmarked procedure as
  checked.
- **Authorization is deliberately not in the contract.** "May this caller do
  this?" often depends on the resource — the order's owner, its state, the
  row's tenant — which cannot be answered before the handler has run and
  fetched it. Putting the caller-shaped half in the contract and leaving the
  resource-shaped half in the handler splits one rule across two files, and
  the half in the contract is the half that looks complete. Authentication —
  "is there a principal, and what is it?" — is answerable before dispatch, and
  is the only half the contract carries.

  A **scope** is the exception that proves the rule, and it is admitted on the
  same test: it is a property of the credential, answerable before dispatch,
  which is exactly why authentication is in the contract already. What stays
  out is resource-dependent authorization — the order's owner, the row's tenant
  — which a scope was never going to answer. `@btravstack/http-server` checks a
  credential's granted scopes against the endpoint's declared ones and answers
  `403`, distinct from the `401` a caller with no valid credential gets.
