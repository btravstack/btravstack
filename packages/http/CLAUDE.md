# packages/http

The HTTP starter's public surface. The root `CLAUDE.md` is the authoritative
spec for the kernel and the conventions; this file holds what only matters when
you are working under `packages/http/`. Keep it in sync with the code in
the same commit, and with `README.md` — the package ships no
`docs-examples.test-d.ts`, so nothing else compiles these claims.

## Public surface

- **`HttpModule(name)({ router, authenticator?, prefix?, port?, hostname?, plugins?, securityHeaders?, imports?, provides?, exports?, needs? })`**
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
  starter's own router port, which is what `HttpRouter(contract)(deps, arm)`
  returns — so a provider of anything else fails at the call, and there is no
  port to read off it: the starter needs `HttpRouterPort`, and the sugar's
  job is to provide it. Covered by the package's own `rpc` fixture, which
  composes `RpcApp` through it. Options `port`/`hostname` pin as for `http()`.
  **`authenticator`** is what a marked contract needs —
  `HttpAuthenticator<P>()({ name: Dep }, { sync })` — and it is a plain optional
  field: present, it joins `provides`, which is all discharging di's need
  takes. `Auth` is inferred from it and `Provides` spreads
  `[Auth] extends [undefined] ? [] : [NonNullable<Auth>]`, so an **omitted**
  authenticator contributes no element and a marked router's need survives
  to `start`, which refuses it — no gate of this package's, and **not** di's
  `UNSATISFIED DEPENDENCIES` arity gate either (that one guards
  `Module.build`/`Module.scoped`): `start`'s `module` parameter takes only
  `Scope | Env` outstanding, so the leftover need fails to assign and the
  diagnostic names the port, ending on
  `Type '"HttpAuthenticator"' is not assignable to type '"@di/Scope"'`.
  What di cannot see is the **principal**: `AuthenticatorPort`'s service type
  is erased to `unknown`, so any authenticator discharges the need whatever it
  resolves. That half is checked here instead — `Principal` is inferred from
  `router`'s own `readonly principal`, and `Auth`'s constraint requires
  `readonly principal: [Principal] extends [never] ? unknown : Principal` — so
  a mismatch fails at the `HttpModule(...)` call, while an **unmarked**
  router (`Principal` is `never`) accepts any authenticator, since a provider
  nothing needs is di's business and not an error to invent. Both are pinned by
  `auth.test-d.ts`, on the two different lines they fire at.
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
  `Parameters<ProcedureImplementer<DefaultInitialContext & object, ContextOf<C>,
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
  test. Only the `sync` arm: a router is built, not
  acquired. `HttpModule({ router: orderRouter })`, or `http()` next to
  `provides: [orderRouter]`, take it from there. Covered by the `rpc` fixture's
  `greetingRouter` (a bare-procedure `oc.router`, one nested) and the stray-key
  guard by `strayRouter` (the same implementation with an undeclared key,
  cast past the types).
- **`HttpRouter(contract)(controllers)` — the keyed form** (`orpc.ts`, a
  second overload of `build`) — for `contract: Record<string, RouterContract>`,
  a record keyed by the contract's own top-level keys, one
  `HttpController` per key, instead of `(deps, { sync })`. `M` is constrained
  `{ readonly [K in Exclude<keyof C, PrincipalKey>]: ControllerFor<Inherit<C[K],
IsMarked<C>>, Identity> }`, and the `controllers`
  **parameter** is typed ``M & { readonly [K in Exclude<keyof M, Exclude<keyof C,
PrincipalKey>>]: `UNDECLARED KEY — the contract declares no fragment under
${K & string}` }`` — the same `Exclude` and the same `Inherit` the
  deps arm's `Implementation<C>` carries, so a **root-marked** contract
  composes here at all (the phantom key is not a controller to supply) and each
  fragment inherits the root's mark (a controller under it types
  `context.principal`). Both were missing until `auth.test-d.ts`'s eleventh arm
  went in; the marked fixtures in `controller.test-d.ts` mark a **key**, which
  is why neither showed there. The exactness intersection is on the parameter, not on `M`: a key
  `M` has that `C` does not declare types as a sentence **naming that key** —
  `"UNDECLARED KEY — the contract declares no fragment under billing"` — so the
  call fails to compile rather than silently
  dropping the key, without the intersection leaking into `M` and collapsing
  the needs channel di orders the controllers by (the failure mode
  `controller.test-d.ts`'s `_ComposedNeedsAreDeclared` check exists to catch).
  It was a bare `never` until the diagnostics pass: `never` made the
  intersection **reduce**, so the whole complaint printed as
  `Type 'Minted<…>' is not assignable to type 'never'` — one short line that
  named neither the key nor the rule. The sentence does not reduce, so the
  reader pays one wide intersection line (the shape four other gates in
  `controller.test-d.ts` already print) and the message **ends** on the rule in
  English, with the offending key in it. `${K & string}` is what carries the
  key: the mapped type is keyed by `K`, so the key is in scope at the value
  position and costs a template literal to reach. The wide-line trade and the
  named key were both **measured** — all five gates still fire, `tsc` clean, no
  widening of `M`. A **symbol** key would intersect to `never` and collapse the
  whole template to `never`, back to the old terse error: that one is
  **reasoned from `K & string`, not measured**, and it is inert anyway, since a
  contract's fragment keys are strings and no call of the keyed form can carry
  a symbol. Do not upgrade it to a measured claim without measuring it.
  **`HttpRouter` is the one helper in the family with THREE forms and only two
  arguments' worth of arity**, so it is the one place arity alone cannot
  decide. `(deps, arm)` is settled by arity as everywhere else; the two
  one-argument forms — an arm, and a controllers record — are told apart by
  whether **`sync` holds a function**. That is total rather than a heuristic:
  this helper accepts no arm but `sync`, so a contract free to declare a key
  called `sync` would put a _controller_ there, and a controller is an object
  carrying a `.port`, never a function. `deps` for the underlying
  `Provider(HttpRouterPort)(...)` is the controllers record with each value
  replaced by its `.port`, so di builds every controller before the router —
  and the services record comes back keyed by the SAME contract keys, so the
  implementation record needs no reassembling before the `routerOf` walk the
  deps form uses.
  Five compile-time gates are pinned by `controller.test-d.ts`: every contract
  key covered, an undeclared key rejected, a controller under the wrong key
  rejected, a procedure a controller's fragment does not declare rejected
  inside the controller, and — the fifth, marked "do not break" — a slice
  lifting out of the composed router **with its controller unchanged**:
  `HttpRouter(contract.orders)({ implementation: orders.port }, { sync: ({ implementation }) => implementation })`
  compiles, so the lifted root declares the very controller the modulith
  composed and hands back what it built. The gate names the controller
  deliberately — a fresh `sync` literal over the fragment would pin only that
  a fragment is a valid contract, the weaker half, which says nothing about
  the controller surviving the lift. All five are pinned **twice**: once
  against a plain contract and once against one whose `orders` fragment is
  `authenticated(...)`, so the marker's phantom key cannot quietly break any of
  them — the fifth least of all. The same block pins the one direction that
  must be refused: a controller whose handler reads `opts.context.principal`
  cannot be mounted under an **unmarked** contract key, where nothing would
  inject one. The reverse is accepted and correctly so — an unmarked
  controller under a marked key is a handler that ignores the principal, which
  is contravariantly fine.
  Covered at runtime by the `rpcSliced` fixture, composing
  `helloController` and `echoesController` over `slicedContract`'s two
  fragments.
- **`HttpController(name, fragment)({ name: Dep }, { sync })`, or `({ sync })`
  with no deps** (`controller.ts`) —
  one slice of a contract, as a provider on a port minted for it. The first
  call fixes `fragment`'s type — read for its type only, so a procedure the
  fragment does not declare or a handler whose input or output has drifted is
  a compile error inside the controller rather than at the root — and mints
  `class extends Port(name)<Implementation<C>> {}`; the second is di's
  `Provider(port)({ name: Dep }, { sync })`, unchanged — **including its
  no-deps arm**, which this helper mirrors by arity for the same reason di
  has one: a controller that calls no use case is the common shape here, not
  an edge case, and `({}, { sync })` is what it would otherwise spell. Returns
  `Provider<PortInstance<Name, Implementation<C>>, never,
InstanceType<D[keyof D]>> & { readonly port: PortClassOf<Name, Implementation<C>> }` —
  the same `PortInstance`/`PortClassOf` spelling `HttpRouter` uses and for the
  same reason (TS4023 on a class expression's own type). The controller does
  no oRPC work: it is a plain record; `HttpRouter`'s `routerOf` walk is what
  wraps a leaf in `.result(...)`, at composition. A slice's module exports
  `controller.port` rather than naming a port of its own — the shape
  `Config.provider("RelayConfig")(schema)` already uses in this repo. Covered
  by `controller.spec.ts`'s `controllers` fixture (the port and declared deps
  a controller carries) and by every gate in `controller.test-d.ts` above.
- **`@btravstack/contract`'s marker, in the types and at runtime.**
  `authenticated(node)` brands a contract node `Authenticated<T>` — an
  intersection with a `unique symbol` key set to `true`, no runtime property
  and **no principal type** — and `Implementation<C, Identity>` branches on
  `IsMarked<C>`. A marked **leaf** gets `{ readonly principal: Identity }` in
  `ProcedureImplementer`'s **second** type parameter (`TInjectedContext`), so
  the principal arrives on `opts.context.principal`: **oRPC's own context
  channel**, not a second handler parameter this package invents and not a
  wrapper around `.result()`. A marked **record** pushes its marker onto each
  child (`Inherit<T, Marked>`), so a marked fragment protects every procedure
  beneath it, and the record arm walks `Exclude<keyof C, PrincipalKey>` so the
  phantom key never becomes a procedure key. An unmarked leaf keeps today's
  spelling, `object`, exactly — which is what makes the negative gate
  meaningful, since `DefaultInitialContext` is an empty interface rather than
  an index signature. `HasMark<C>` (exported from `orpc.ts` **and** from
  `index.ts`) is **whether** a contract marks anything anywhere in its tree —
  exactly `true` or exactly `false`, asserted both directions in
  `auth.test-d.ts` because a `boolean` result would satisfy either. Pinned by
  `auth.test-d.ts`, mutation-checked. What makes the type true at runtime is
  `principalMiddleware`, below.
- **`HttpAuthenticator<P>()({ name: Dep }, { sync })` — or `({ sync })`, the
  common shape, since an authenticator reading only headers declares no
  dependencies — plus `AuthenticatorPort`,
  `Unauthenticated`, `AuthenticatorService<P>`** (`auth.ts`) — what an
  application provides so a marked procedure can name its caller.
  `AuthenticatorService<P>` is
  `(headers: IncomingHttpHeaders) => AsyncResult<P, Unauthenticated>` —
  **headers, not the request**: an authenticator has no business reading a
  body, and the narrower argument is what keeps it testable without a socket.
  `AuthenticatorPort` is `Port("HttpAuthenticator")` cast to
  `PortClassOf<"HttpAuthenticator", AuthenticatorService<unknown>>`, the same
  spelling and for the same reason as `HttpRouterPort`; its service type is
  **erased to `unknown`** because the principal's type is carried by the
  provider instead — `HttpAuthenticator<P>()` returns
  `Provider<AuthenticatorPort, never, …> & { readonly principal: P }`. The
  type argument is explicit rather than inferred from `sync`: inference
  through a returned function's `AsyncResult` is exactly where a `Principal`
  silently widens to `unknown`. `Unauthenticated` is a `TaggedError` with an
  **empty payload**: the starter surfaces no reason — a refused caller gets an
  `UNAUTHORIZED` and oRPC's default message — so a field here would be
  write-only. An authenticator that wants to record why logs it before
  returning. Forwarding a reason would put "no such user" versus "bad
  signature" in a 401 body by default.
- **`httpAuth<Identity>()` → `{ HttpController, HttpRouter, HttpAuthenticator }`,
  plus `HttpControllerOf<Identity>` / `HttpRouterOf<Identity>` /
  `HttpAuthenticatorOf<Identity>`**
  (`http-auth.ts`) — **the** place a principal type is stated.
  **The contract says whether a route is protected; this says what the
  principal is.** `Implementation<C, Identity>` and `ContextOf<C, Identity>`
  carry it: a **marked** leaf's `opts.context.principal` is `Identity`, an
  **unmarked** one is still `object`. `Identity = never` is "no factory", and
  the top-level `HttpController` / `HttpRouter` are `controllerFor<never>()` /
  `routerFor<never>()` — so a marked fragment reached through them types
  `principal: never` and **any read of it is a compile error** (measured:
  TS2339 on a property of `never`). That is the "use the factory" signal, and
  it is the only thing the top-level form can honestly say now that the
  contract carries no principal to fall back on. `controllerFor` and
  `routerFor` are exported from their own files for this factory alone, not
  from `index.ts`.
  What it replaced: a principal type named in the contract, which put the
  server's own view of a caller — a user id, roles — in the artifact a client
  imports, and left a handler unable to see anything the contract had not
  published.
  It is **per application, not per slice**, and that is forced rather than
  chosen: a handler's parameter types are fixed where the arrow is written, so
  a composition root cannot retroactively re-type a `sync` callback in another
  module. The identity must be in scope where the handler is, and the factory
  is how it gets there with no per-call-site annotation.
  The three `…Of<Identity>` aliases exist because a file **exporting** what the
  factory returns cannot infer it: a controller's port expands to a type
  carrying `@btravstack/contract`'s phantom `unique symbol` (TS2527, measured
  on `examples/order-api`, and the same reason `HttpController` /
  `HttpRouter` themselves are annotated `ReturnType<typeof controllerFor<never>>`
  here). `HttpAuthenticator` is handed back **already applied** — the type
  argument it exists to state is what the factory just fixed — so it is called
  `HttpAuthenticator({ name: Dep }, { sync })`.
  `HttpModule`'s gate compares the authenticator's principal to the
  **router's** identity, both of which come from the same `httpAuth` call in an
  ordinary application. Pinned by `auth.test-d.ts`'s arms 12–16 (the identity
  on a marked leaf, the top-level form typing `principal: never` on the same
  fragment, no principal invented on an unmarked one, the keyed compose, and a
  stray authenticator refused) and at runtime by `auth.spec.ts`'s `rpcAuthed`
  fixture, whose contract names no identity at all and whose handler reads a
  `userId` only the factory typed.
- **`principalMiddleware` and `noAuthenticator`** (`auth.ts`, internal —
  **not** exported from `index.ts`, like `HttpHandler`) — the one middleware this package installs,
  and only on a marked leaf. It reads the request off oRPC's **initial
  context** (`orpc()` now passes `context: { request }` to
  `RPCHandler.handle`, which is what initial context is for), calls the
  authenticator with its headers, and either injects
  `{ context: { principal } }` through `next` or terminates the request. An
  `Unauthenticated` becomes `throw new ORPCError("UNAUTHORIZED")` — oRPC's
  middleware protocol has no returned-error arm, which is the one place in
  this package a `throw` is right, carried by an `unthrown/no-throw` disable
  naming why. **No message is derived from the refusal**: oRPC serializes
  `message` to the client, so the caller gets oRPC's default `"Unauthorized"`
  and the `reason` never leaves the process. Pinned by `auth.spec.ts`'s
  _"answers 401 without the authenticator's reason"_, mutation-verified. A
  **defect** is rethrown as its own cause instead, so a bug in the
  authenticator stays oRPC's `INTERNAL_SERVER_ERROR` collapse rather than
  being reported as a rejected caller.
- **The authenticator dependency is conditional, and the two halves must
  agree — a disagreement is an auth bypass.** `routerOf` walks the
  **contract** alongside the implementer, carrying an `inherited` flag —
  `isAuthenticated(node)` answers for one node only, so a marked record's mark
  is pushed down by the walk exactly as `Inherit<T, P>` pushes it in the types
  — and a marked leaf becomes
  `node.use(principalMiddleware(authenticate)).result(fn)`. **`.use` before
  `.result`, never the reverse**: `.result` returns an `ImplementedProcedure`
  whose own `.use` has no `.result` left. Three things keep the two halves
  from parting, each of which was a live bypass before it was fixed:
  - **The walk is seeded with `isAuthenticated(contract)`, not `false`.** The
    root node has no `contract[key]` to be read from, so a marked **root** —
    `HttpRouter(authenticated(contract))` — would otherwise wrap nothing at
    all while `Implementation<C>`'s record arm typed every leaf with a
    principal that never arrived. Pinned by `auth.spec.ts`'s
    `rpcRootMarked` fixture, mutation-verified.
  - **`hasMarked` enters every object, not only plain records**, cycle-guarded
    by a `WeakSet` (a schema is free to be recursive). Anything it declines to
    enter is a mark it can miss and the walk cannot, and missing one is the
    unsafe direction; over-approximating only ever declares an authenticator
    nothing uses.
  - **A mark with no authenticator behind it fails closed**, through
    `auth.ts`'s `noAuthenticator` — an `AuthenticatorService` that refuses
    every caller, so the leaf answers `401` instead of serving unprotected.
    Unreachable while the two halves agree, which is exactly why it is there.

  It also takes **`needs`**, forwarded to di's own — what this root's OWN
  providers expect from outside. The starter's `Env` is not among them: the
  starter is an import, and an import's needs travel without being restated. A
  root that provides a config provider of its own does declare it —
  `examples/order-amqp-worker` says `needs: [Env]` for `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

  When `hasMarked(contract)` answers true,
  `AuthenticatorPort` joins the provider's deps record under the **namespaced**
  key `"@btravstack/http/authenticator"` — namespaced for the same reason
  `tapped`'s port id is, since every other key on that record is a name the
  caller chose and this one must not be able to collide with a dependency
  somebody called `authenticator`; `sync` reads it off the services record and
  hands the caller's own `sync` the rest — and both `build` overloads add
  `HasMark<C> extends true ? AuthenticatorPort : never` to the needs channel
  plus `readonly identity: Identity` to the result.
  A marked router whose root provides no authenticator is therefore an
  ordinary unmet need refused at `start` — no new gate, and not di's arity
  gate (see the `authenticator` bullet for what prints). Whether the
  authenticator resolves what the handlers read is the one thing that
  gate cannot see, and `HttpModule`'s `authenticator` option is where it is
  checked (see the first bullet). Note
  `oc.router(...)` **rebuilds** every node, so a marker applied inside a
  builder chain is lost — on **both** sides at once
  (`AugmentedContractRouter<T, …>` maps `[K in keyof T]` and answers `never`
  for the phantom key, so `IsMarked` loses it too), which makes it a
  dropped protection rather than a bypass. `authenticated(...)` is applied to
  the finished node, which is what `@btravstack/contract` already documents.

- **`http({ prefix?, port?, hostname?, plugins?, securityHeaders? })` →
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
  `principalMiddleware` (below) is the one per-request hook this package
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
  `start`'s phantom marker — intersected onto `module`, not a rest tuple — turns
  a composition exporting no `HttpRuntime` into a `TS2345` whose last line is
  `"NO RUNTIME — the module exports no port declared over RuntimePort"`; and
  because the runtime provider depends on the router port **through di**,
  a composition that imports `http()` without providing the router
  carries `HttpRouterPort` as an unmet need `start` refuses on the same
  parameter's `Module<X, E, Scope | Env>` half, ending on
  `Type '"HttpRouter"' is not assignable to type '"@di/Scope"'`. Neither is
  di's `UNSATISFIED DEPENDENCIES` arity gate.
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
- **40 specs, 100% lines/functions.** Every app boots through the `boot`
  fixture — `@btravstack/testing`'s `bootFixture()`, which `serve`, `rpc`,
  `configured` and `appOnPort` depend on — so it is stopped when the test
  ends, on every exit path, and the teardown is Defect-only: a startup
  failure (`configured`'s `ConfigInvalid`, `occupied`'s port in use) is the
  test's to assert on `app.exited`. `http-runtime.spec.ts` carries 21,
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
  `access-control-allow-origin`. `controller.spec.ts` carries the
  remaining 2, through the `controllers` and `rpcSliced` fixtures: a
  `HttpController` carries the port it was minted under and the deps it
  declared, and `HttpRouter(contract)({...})` serves a router composed from
  two controllers — `helloController` and `echoesController`, each over its
  own fragment of `slicedContract` — with a procedure from each answering
  through one client, proving every controller's slice was mounted under its
  own contract key. A process still serves one router (thesis #1); the keyed
  form changes how many providers build it, not that fact. `auth.spec.ts`
  carries the last 9, through the `rpcAuthed`, `rpcRootMarked`,
  `authedRouterDeps` and `controllers` fixtures — every one of them over a
  router, controllers and authenticator minted by ONE `httpAuth<Identity>()`,
  since a contract naming no principal leaves the factory as the only way a
  handler gets a readable one. Four are over
  `authedContract` — `{ orders: authenticated({ whoami }), health: { ping } }`,
  one protected fragment and one public one: the handler reading a `userId`
  only the factory typed, a rejected token answering `UNAUTHORIZED` with the
  handler never entered, an authenticator's own defect collapsing to
  `INTERNAL_SERVER_ERROR` rather than a 401, and an unmarked procedure served
  with no credentials at all. Two are over `rootMarkedContract` —
  `authenticated({ orders: { whoami } })`, the mark on the **root**, where
  there is no `contract[key]` to read it from: a rejected token still gets a
  401 with the handler never entered, and an accepted one still reaches the
  handler with its principal. Two are composition-time — the authenticator
  appended **last** in both `build` arms, and nothing appended at all when the
  contract marks nothing. The ninth is `noAuthenticator` itself, refusing
  every caller.
  `controller.test-d.ts` is the package's own compile-time gate — see Public
  surface.
