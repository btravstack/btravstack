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
  **A ceiling in the dot encoding itself, not a bug in the mechanism**: `nest`
  rebuilds a piece's path by splitting on `.`, so it cannot tell a path
  separator from a literal dot inside one contract key — a contract keyed
  `{ "a.b": oc }` mints a piece at path `"a.b"`, passes coverage, and `nest`
  then splits it into `{ a: { b: fn } }`, which `routerOf`'s stray-key drop
  silently discards: a fully green compile and a 404 at runtime. The escape
  is the `(deps, arm)` form, which never splits anything. No guard exists
  today; `orpc.ts`'s `nest` carries a `ponytail:` comment naming the two
  upgrade paths (a runtime guard, or excluding dotted keys from
  `ControllerKeyOf` so a literal-dot key is never mintable as a piece path).
  The return is the same `Built<Auth, N>` as the other arms, with
  `N = InstanceType<T[number]["port"]> | SchemePortsOf<C>`.
  Five compile-time gates are pinned by `controller.test-d.ts`: every
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
  composed and hands back what it built. The gate names the piece
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
- **`@btravstack/contract`'s marker, in the types and at runtime.**
  `authenticated(...requirements)(node)` brands a contract node
  `Authenticated<T, R>` — an
  intersection with a `unique symbol` key holding the exact `Requirements`, no
  runtime property
  and **no principal type** — and `Implementation<C, Schemes>` branches on
  `IsMarked<C>`. A marked **leaf** gets
  `{ readonly principal: Principal<SchemesOf<R>, Schemes> }` in
  `ProcedureImplementer`'s **second** type parameter (`TInjectedContext`), so
  the principal arrives on `opts.context.principal`: **oRPC's own context
  channel**, not a second handler parameter this package invents and not a
  wrapper around `.result()`. A marked **record** pushes its requirements onto
  each child that carries none (`Inherit<T, R>`), so a marked fragment protects
  every procedure beneath it while a procedure's own mark **replaces** that
  default for itself — **nearest mark wins**, which is OpenAPI's own rule and
  what `Effective<C, R>` spells. The record arm walks
  `Exclude<keyof C, PrincipalKey>` so the
  phantom key never becomes a procedure key. An unmarked leaf keeps today's
  spelling, `object`, exactly — which is what makes the negative gate
  meaningful, since `DefaultInitialContext` is an empty interface rather than
  an index signature. `HasMark<C>` (exported from `orpc.ts` **and** from
  `index.ts`) is **whether** a contract marks anything anywhere in its tree —
  exactly `true` or exactly `false`, asserted both directions in
  `auth.test-d.ts` because a `boolean` result would satisfy either. Pinned by
  `auth.test-d.ts`, mutation-checked. What makes the type true at runtime is
  `principalMiddleware`, below.
- **`Principal<S, Schemes>` and `SchemesOf<R>`** (`principal.ts`) — what a
  leaf's handler actually reads, from the scheme NAMES its effective
  requirements union to. **One scheme is the identity bare**, byte-for-byte
  what applications wrote before this feature, so the common case pays nothing
  for it; **several schemes are a discriminated union**,
  `{ scheme, identity }` per arm, narrowed with an exhaustive `switch` whose
  missing arm is a compile error; **no scheme is `never`**, so a public leaf's
  `principal` cannot be read at all. `SchemesOf<R>` maps over the tuple and
  then indexes — `{ [I in keyof R]: keyof R[I] & string }[number]` — and is
  **not** `keyof R[number]`, which is the INTERSECTION of each requirement's
  keys and collapses to `never` the moment two requirements name different
  schemes: exactly the multi-scheme case, and it failed silently (measured).
  `IsUnion<T>` is the standard distribute-then-compare-back test; do not
  "simplify" it to `T extends U`. All seven arms are pinned by
  `principal.test-d.ts` — the last of them asserting `SchemesOf` in **both**
  directions, since a one-way assignment out of a collapsed `never` passes and
  is how the first cut of that test missed a broken `SchemesOf` entirely.
- **`HttpAuthenticator<P, Scope>()({ name: Dep }, { sync })` — or `({ sync })`, the
  common shape, since an authenticator reading only headers declares no
  dependencies — plus `authenticatorPort(scheme)`,
  `Unauthenticated`, `granted(identity, scopes)`, `Grant<P, Scope>`,
  `Granted<P, Scope>`, `AuthenticatorService<P, Scope>`**
  (`auth.ts`) — how one **security scheme** is implemented.
  `AuthenticatorService<P, Scope>` is
  `(headers: IncomingHttpHeaders) => AsyncResult<Granted<P, Scope>, Unauthenticated>` —
  **headers, not the request**: an authenticator has no business reading a
  body, and the narrower argument is what keeps it testable without a socket.
  `Granted<P, Scope>` is `P` when `Scope` is `never` — a scheme with no scope
  vocabulary returns the identity bare, byte-for-byte what applications wrote
  before — and `Grant<P, Scope>` when it has one, so
  the granted list is checked against the declared vocabulary at the
  authenticator rather than compared as loose strings at the endpoint.
  **`Grant` is BRANDED with a module-private `unique symbol` and `granted()`
  is the only thing that mints one**, which makes the helper mandatory rather
  than advisory: a hand-built `{ identity, scopes }` does not type-check as the
  scoped answer. The type parameter is erased at runtime, so a structural test
  is the alternative and is unsound — `"scopes" in answer` reads a
  claims-shaped BARE identity (`{ userId, tenantId, scopes }`, the ordinary JWT
  case) as the scoped one, injects its absent `identity`, and hands every
  handler on that route `undefined`. `Symbol.for` rather than `Symbol()`: two
  copies of this package would otherwise read each other's grants as bare.
  `Scope` is not inferred from the vocabulary on `granted` itself — an empty
  grant would collapse it to `never` and take the return type back to the bare
  arm — so the array states it and the assignment checks it.
  `authenticatorPort(scheme)` mints
  ``Port(`HttpAuthenticator:${scheme}`)<AuthenticatorService<unknown>>`` — the
  move `AmqpHandler(contract, key)` makes, with the scheme name on the port
  **id**, so `HttpAuthenticator:user` and `HttpAuthenticator:service` are
  different types and a scheme with nobody behind it is di's own unmet need
  naming the port. It is **memoised** in a module-level `Map`: `defineHttp`
  asks for a port when it binds an authenticator and `routerFor` asks again for
  every scheme its contract names, and two `Port(id)` calls under one id are
  di's duplicate-id warning. The service type is **erased to `unknown`**
  (`Granted<unknown, never>` is `unknown`, so it admits the bare and the scoped
  answer alike) because di identifies a port by id; the principal and scope
  types ride the description `HttpAuthenticator` hands back —
  `{ deps, options, principal: P, scope: Scope, needs: N }` — which is what
  `defineHttp` binds and reads the registry off.
  Both type arguments are explicit rather than inferred from `sync`: inference
  through a returned function's `AsyncResult` is exactly where a principal
  silently widens to `unknown`. The **scheme name is not stated here** — it is
  the key this authenticator sits under in `defineHttp({ authenticators })`, so
  it is written once. `Unauthenticated` is a `TaggedError` with an
  **empty payload**: the starter surfaces no reason — a refused caller gets an
  `UNAUTHORIZED` and oRPC's default message — so a field here would be
  write-only. An authenticator that wants to record why logs it before
  returning. Forwarding a reason would put "no such user" versus "bad
  signature" in a 401 body by default.
- **`defineHttp({ authenticators })` → `Http<A>`, carrying `HttpController`,
  `HttpRouter` and `authenticators`** (`define-http.ts`) — **the one door** to
  the marker-typed entities, and the place a scheme registry is stated.
  **The contract says which schemes protect a route; this says what each one
  resolves to.** `SchemesFrom<A>` reads the registry off the authenticators
  (`{ [K in keyof A]: A[K]["principal"] }`) rather than having it declared a
  second time, and `Implementation<C, Schemes>` / `ContextOf<C, R, Schemes>`
  carry it down to each leaf. Declaring a scheme and implementing it are **the
  same act**, so a scheme with no authenticator is not a state this can reach —
  there is no coverage gate because there is nothing to forget.
  `Schemes = never` is "no factory": a marked fragment reached through anything
  but a `defineHttp` call types `principal: never` and **any read of it is a
  compile error** (measured: TS2339 on a property of `never`). That is the
  "use the factory" signal. `controllerFor` and
  `routerFor` are exported from their own files for this factory alone, not
  from `index.ts`, and there is **no** top-level `HttpController` / `HttpRouter`
  any more: a form whose principal could only ever be `never` was a trap with
  no correct use.
  The default type argument is `Record<never, never>`, **not**
  `Record<string, never>`: an index signature over `string` would make every
  scheme's port look available to di, so a marked contract composed under
  `defineHttp()` would type-check and then fail at build. Empty, the port stays
  unmet and the composition is refused.
  **The result is held as ONE binding and never destructured.** Each binding of
  a destructured member expands to a type mentioning `@btravstack/contract`'s
  inaccessible `unique symbol`, which is TS2527 (measured); held whole, the
  inferred type collapses to `Http<A>`, which is nameable — so an application
  writes **no type annotation at all**, and the three `…Of<Identity>` aliases
  the previous factory needed are gone with the annotations they existed for.
  At runtime the call binds one provider per scheme —
  `Provider(authenticatorPort(scheme))(deps)` or `(deps, options)`, discriminated
  by whether `HttpAuthenticator`'s no-deps arm left `options` undefined, the
  same arity discrimination `Provider(port)` makes — and hands them to
  `routerFor`, which carries them out on `provider.authenticators`.
  It is **per application, not per slice**, and that is forced rather than
  chosen: a handler's parameter types are fixed where the arrow is written, so
  a composition root cannot retroactively re-type a `sync` callback in another
  module. The registry must be in scope where the handler is, and the factory
  is how it gets there with no per-call-site annotation.
  What it replaced: a principal type named in the contract, which put the
  server's own view of a caller — a user id, roles — in the artifact a client
  imports; and then a single-identity factory, which named **one** identity per
  application and so could not describe a route two different kinds of caller
  may reach. Pinned by `define-http.test-d.ts` (the registry inferred from the
  authenticators, the no-argument call, an authenticator's own dependency
  riding through), by `auth.test-d.ts`'s arms 7–12, and at runtime by
  `auth.spec.ts`'s `rpcAuthed`, `rpcRootMarked` and `rpcVerified` fixtures.
- **`principalMiddleware(requirements, authenticators)`** (`auth.ts`, internal —
  **not** exported from `index.ts`, like `HttpHandler`) — the one middleware this package installs,
  and only on a leaf whose effective requirements say so. It reads the request
  off oRPC's **initial
  context** (`orpc()` passes `context: { request }` to
  `RPCHandler.handle`, which is what initial context is for) and tries the
  requirements **in the order the contract declared them**, taking the first a
  caller satisfies, then injects `{ context: { principal } }` through `next`.
  Four decisions live here, each pinned by `auth.spec.ts`:
  - **Tagged when the leaf names more than one SCHEME**, not more than one
    requirement — `new Set(requirements.flatMap(Object.keys)).size > 1`. One
    requirement may name several schemes, and counting requirements disagreed
    with `SchemesOf`, which unions scheme names across all of them: the handler
    typed `Tagged` while this injected bare, so `principal.scheme` read
    `undefined` with **no type error to catch it**.
  - **A required scope is not satisfied by a credential reporting none.** A
    scheme declared without a vocabulary answers bare, and skipping the
    comparison for it admitted the caller outright — the one place in this
    package where the failure direction matters. An empty `required` still
    passes trivially.
  - **`403` is not `401`.** A credential that was valid but under-scoped gets
    `FORBIDDEN`; only a caller no requirement accepted at all gets
    `UNAUTHORIZED`. Both are `throw new ORPCError(...)` — oRPC's
    middleware protocol has no returned-error arm, which is the one place in
    this package a `throw` is right, carried by an `unthrown/no-throw` disable
    naming why — and **neither derives a message from the refusal**: oRPC
    serializes `message` to the client, so the caller gets oRPC's default and
    the reason never leaves the process.
  - **A defect short-circuits rather than falling through.** A defect is a bug
    in the authenticator, not a refusal; falling through would let a broken
    verifier silently promote every caller to the next scheme. It is rethrown
    as its own cause, so it stays oRPC's `INTERNAL_SERVER_ERROR` collapse.

  The authenticators arrive as a plain record keyed by scheme, and the lookup
  is **asserted, not guarded**: the router declares one dep per scheme its
  contract names, so every scheme a requirement names is a key here and di
  refuses the graph long before a request lands. That is also why
  `noAuthenticator` — the fail-closed stand-in the single-scheme design needed
  — is gone: there is no "marked but unwired" state left for it to cover.

- **A contract may name a scope only if the scheme's authenticator can grant
  it.** `routerFor` intersects `ScopeGate<C, Vocab>` onto its `contract`
  parameter — `unknown` when satisfied, an object with one required property
  when not, which is what makes the diagnostic end on the offending scope
  (measured: `… "UNGRANTABLE SCOPE — its scheme's authenticator cannot grant
it": "order:export"`). `VocabFrom<A>` reads the vocabulary off the same
  authenticators `SchemesFrom<A>` reads the principals off — two projections
  because they answer different questions at different call sites: the
  principal types the handler, the vocabulary checks the contract.

  Two cases it catches, and both used to be silent (#90): a typo, and a scope
  asked of a scheme declared with no vocabulary at all — `Scope = never`, so
  everything is ungrantable. Both compiled, passed all six gate commands, and
  then refused every caller on that route with a permanent 403 and no
  diagnostic anywhere. It is the sibling of the scheme-NAME check, which di
  performs already by leaving an unknown scheme's port unmet — and the two do
  NOT overlap: a scheme the registry does not know is skipped by this gate
  entirely, so a misspelled scheme naming scopes reports the port it cannot
  discharge (`PortInstance<"HttpAuthenticator:usre", …>`) rather than a scope
  complaint. Treating an unknown scheme as an empty vocabulary made every scope
  it named ungrantable, which was the wrong diagnostic AND the earlier one,
  since this gate sits on the router mint and the unmet port on the composition
  root.

  A requirement naming no scopes contributes `never` and costs nothing, which
  is the common case. One shape inside is load-bearing: `ScopesIn` asks
  `K extends keyof R[I]` **before** indexing, because indexing a requirement
  that does not name `K` gives `never`, and inferring the element type from
  `never` falls back to its constraint — `string` — so every scope looked
  grantable the moment two requirements named different schemes. Measured; do
  not "simplify" it back to `R[I][K & keyof R[I]]`.

- **The scheme dependencies are read off the contract, and the two halves must
  agree — a disagreement is an auth bypass.** `routerOf` walks the
  **contract** alongside the implementer, carrying an `inherited` requirements
  value —
  `isAuthenticated(node)` answers for one node only, so a marked record's
  requirements are
  pushed down by the walk exactly as `Inherit<T, R>` pushes them in the types,
  and a node's own mark **replaces** what it inherited, exactly as
  `Effective<C, R>` does — and a leaf with effective requirements becomes
  `node.use(principalMiddleware(effective, authenticators)).result(fn)`. **`.use` before
  `.result`, never the reverse**: `.result` returns an `ImplementedProcedure`
  whose own `.use` has no `.result` left. Three things keep the two halves
  from parting:
  - **The walk is seeded with `isAuthenticated(contract)`, not `undefined`.** The
    root node has no `contract[key]` to be read from, so a marked **root** —
    `api.HttpRouter(authenticated({ user: [] })(contract))` — would otherwise wrap nothing at
    all while `Implementation<C, Schemes>`'s record arm typed every leaf with a
    principal that never arrived. Pinned by `auth.spec.ts`'s
    `rpcRootMarked` fixture, mutation-verified.
  - **`schemesOf` enters every object, not only plain records**, cycle-guarded
    by a `WeakSet` (a schema is free to be recursive), and does **not** stop at
    a mark — a procedure inside a marked record may name a scheme of its own,
    and that scheme still needs a port. Anything it declines to
    enter is a mark it can miss and the walk cannot, and missing one is the
    unsafe direction; over-approximating only ever declares a port nothing
    uses. Its type-level twin is `SchemePortsOf<C>`, built on
    `AllRequirementsOf<C>` — the same tree walk as `HasMark<C>`, keeping what
    it found instead of answering yes — and the two must agree.
  - **A scheme with no authenticator behind it does not build.** There is no
    fail-closed stand-in any more, and none is wanted: the router names one
    port per scheme, `defineHttp` binds one provider per authenticator, and a
    scheme in the first set but not the second is di's own unmet need naming
    `HttpAuthenticator:<scheme>` — refused before a request can arrive rather
    than answered `401` once one has.

  It also takes **`needs`**, forwarded to di's own — what this root's OWN
  providers expect from outside. The starter's `Env` is not among them: the
  starter is an import, and an import's needs travel without being restated. A
  root that provides a config provider of its own does declare it —
  `examples/order-amqp-worker` says `needs: [Env]` for `relayConfig`. The sugar
  **re-declares di's `NeedsGate`** over its augmented tuples, so a root whose
  own provider owes a port it does not name is refused at THIS call rather than
  slipping past into `start`; see `packages/di/CLAUDE.md`'s **Module
  visibility**.

  For every scheme `schemesOf(contract)` found, that scheme's port joins the
  provider's deps record under the **namespaced**
  key the `AUTHENTICATOR` constant builds — `"@btravstack/http-server/authenticator"`
  plus a trailing colon, then the scheme name — namespaced for the same reason
  `tapped`'s port id is, since every other key on that record is a name the
  caller chose and these must not be able to collide with a dependency
  somebody called `user`; `sync` reads them off the services record into the
  record `principalMiddleware` takes and
  hands the caller's own `sync` the rest — and all three `build` overloads add
  `SchemePortsOf<C>` to the needs channel
  plus `readonly authenticators` to the result.
  A router naming a scheme nobody implements is therefore an
  ordinary unmet need refused at `start` — no new gate, and not di's dependency
  gate. There is nothing left for a
  gate to check afterwards: the registry that types the handlers and the
  providers that discharge the ports come from the **same** `defineHttp` call,
  so they cannot disagree. Note
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
- **54 specs, 100% lines/functions.** Every app boots through the `boot`
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
  `access-control-allow-origin`. `controller.spec.ts` carries 5, through the
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
  the shared parent is what forces `nest`'s `node[segment] ??= {}` to find a
  node the first piece already created rather than only ever creating one,
  and `"health"` is the depth-N leaf case, a piece with no fragment around it
  at all. A process still serves one router (thesis #1); the composing
  form changes how many providers build it, not that fact. `auth.spec.ts`
  carries the last 18, through the `rpcAuthed`, `rpcRootMarked`,
  `controllers` and `headers` fixtures — every router, controller and
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
  handler with its principal. Two are composition-time — the scheme's own port
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
