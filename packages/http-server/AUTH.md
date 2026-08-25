# `@btravstack/http-server` — the authentication surface

The authentication half of this package's public surface. It governs
`auth.ts`, `principal.ts`, `define-http.ts` and the `@btravstack/contract`
marker; **read it before changing any of those.** The rest of the surface —
the router, the controller, `HttpModule`, the runtime and the internal seam —
is in `packages/http-server/CLAUDE.md`, and the repository-wide theses are in
the root `CLAUDE.md`.

The two rules this half exists to state, before the detail:

- **The contract says WHICH SCHEMES protect a route, and which scopes each
  must grant; the application's `defineHttp({ authenticators })` says WHAT
  each scheme resolves to.**
- **An unmarked procedure is public, and nothing fails if the marker is
  forgotten.** The contract is the only statement of intent there is. Do not
  describe an unmarked procedure as checked.

## Surface

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
