# @btravstack/http-server

## 0.4.0

### Patch Changes

- @btravstack/config@0.4.0
  - @btravstack/contract@0.4.0
  - @btravstack/core@0.4.0
  - @btravstack/di@0.4.0

## 0.3.0

### Minor Changes

- e8236b2: Let a contract declare that a procedure requires an authenticated caller, and
  give `@btravstack/http-server` what it needs to satisfy that declaration.

  **The contract says which schemes protect a route; the application says what
  each one resolves to.**

  `@btravstack/contract` is a new zero-dependency package holding the marker
  itself, applied to a finished procedure or to a whole record of them. It
  names no identity type at all, so nothing about a server's view of a caller
  reaches a client. It returns the node unchanged — the marker lives in a
  `WeakMap` off `globalThis` and a phantom type key — so a client can import a
  marked contract without pulling in anything that implements it. `IsMarked<T>`
  answers the yes/no at the type level, `isAuthenticated(node)` reads the
  requirements back at runtime. An
  unmarked procedure is public; the marker makes the requirement legible in the
  contract rather than detecting one that was forgotten. Its full shape — the
  curried `authenticated(...requirements)(node)`, scopes and per-procedure
  overrides — is in the _named security schemes_ entry.

  `@btravstack/http-server` resolves the principal before dispatch, through an
  authenticator per scheme. A contract that marks nothing needs none; a marked
  router whose graph provides none carries that scheme's port as an
  unmet need `start` refuses. A marked procedure whose
  authenticator declines is answered `UNAUTHORIZED` before dispatch, with the
  handler never running and no reason reaching the caller — `Unauthenticated`
  carries none, so an authenticator logs why before returning.

  `http()` and `HttpModule` also gain `plugins`, forwarding oRPC handler plugins
  (CORS, body limits, compression, CSRF) straight to `RPCHandler`, and
  `securityHeaders`, applied on the node listener rather than as a plugin so the
  runtime's own `404` is covered too. `plugins` is an honest escape hatch rather
  than a keyhole — an oRPC plugin's `init` can reach the handler's interceptors —
  but the ordinary path is configuration visible at the composition root, not a
  middleware slot for application logic.

- 6f964fa: A module declares what its own providers expect from outside

  `Module(name)({ … })` takes a fourth list, `needs`. A port **this module's own
  providers** read, and that nothing here satisfies, must be named there; anything
  they owe and it does not name is refused at that call, with the port in the
  message:

  ```
  Property '"UNDECLARED NEEDS — name it in `needs`"' is missing in type
    '{ provides: [...]; exports: [...]; }' but required in type
    '{ readonly "UNDECLARED NEEDS — name it in `needs`": Logger; }'.
  ```

  Before this, a need nothing local satisfied simply travelled to whoever
  composed the module, and a composition root could satisfy an imported module's
  dependency without that module ever mentioning it — measured: a slice's
  provider received the root's service while importing nothing at all. A slice
  directory could not be read on its own.

  `needs` is the explicit stand-in for NestJS's `@Global`, which this container
  does not have and now does not need: the port is named, the supplier is not, so
  the slice still composes into any root that answers it.

  **An import's own needs are not the importer's to re-declare.** They are already
  published in the import's type, and the entry point still refuses a root that
  has not discharged them — so the declaration lands on the feature that reads the
  port, once, rather than on every module between it and the root. That is
  `ConfigModule.forFeature`'s shape reached without a global: `DatabaseModule`
  says `needs: [Env]` because it reads `DATABASE_URL`, and the persistence modules
  and slices that import it say nothing.

  `Scope` is exempt — nothing can provide it, and the entry point discharges it.

  The three starter sugars — `HttpModule`, `AmqpModule`, `TemporalModule` — take
  `needs` too and re-declare the gate over their augmented tuples, so a
  composition root written with a sugar is checked exactly like a bare
  `Module(name)`.

  `@btravstack/di` additionally exports `NeedsGate` and `Unmet`, which a package
  offering its own shaped module needs in order to re-declare the gate.

- 9af980d: The compile-time gates name what is missing. `start`'s markers rode a phantom
  rest tuple, whose failure is an arity error — and arity errors never print
  types, so `NO RUNTIME` never reached a reader and TypeScript's related info
  pointed at the wrong fix. They ride the module parameter now.

  `start`, `runMain` and `bootFixture` no longer take the trailing gate argument.
  No production call site passed one; the documented hand-spelled bypass went
  with it, so this is a signature change without a migration.

  The same widening reached the composers: `AmqpHandlers`'s/`TemporalActivities`'s
  `UNCOVERED HANDLERS`/`UNCOVERED ACTIVITIES` marker and `HttpRouter`'s
  `UNDECLARED KEY` marker now say the rule in English and name the missing key,
  where each used to end on a bare `"UNCOVERED HANDLERS"` or `never`.

- a651493: Add `HttpController(contract, path)({ name: Dep }, { sync })` and a composing
  `HttpRouter(contract)([piece, …])` form, so a large API can be split into
  slices that each own one node of the contract tree — a fragment, a nested
  fragment, or a bare procedure — and its implementation. Both come off
  `defineHttp` — see the _named security schemes_ entry.

  A controller is an ordinary di provider on a port minted straight from the
  contract path it serves, with no name to give: the path **is** the port's
  name. The root composes an array of them, exact over the contract's
  procedures — a missing piece, a path the contract does not declare (refused
  at the piece's own mint, not at the router), a piece under the wrong path
  (impossible by construction, since the path rides its own port id), and two
  pieces whose paths nest one inside the other are all compile errors. A
  contract marked at any ancestor of a piece's path types that piece's
  `context.principal`, exactly as `routerOf`'s runtime walk protects it. The
  `HttpRouter(contract)(deps, { sync })` form is unchanged and still right for
  a small API.

  Because a fragment is itself a valid contract, a slice can be served as its
  own process without changing its piece.

- 54de3fa: Let a contract name **which security schemes** a procedure accepts and **which
  scopes** each must grant, and let an application say what each scheme resolves
  to — in one call.

  `@btravstack/contract`'s marker carries OpenAPI's own requirement shape instead
  of a boolean. `authenticated` is now **curried**:
  `authenticated(...requirements)(node)`, where a `Requirement` is
  `Readonly<Record<string, readonly string[]>>` — a scheme name mapped to the
  scopes it must grant, and **exactly one scheme**: a second key does not
  compile, because OpenAPI reads two keys in one requirement as AND while this
  starter walks them as OR, so a requirement copied out of an OpenAPI document
  would silently execute a weaker rule than the one it states. Several
  requirements are **ORed**, tried in declaration order. Applied to a record it is the default for every procedure beneath it;
  applied to a procedure it **replaces** that default for itself — nearest mark
  wins, which is OpenAPI's rule. `isAuthenticated(node)` answers
  `Requirements | undefined` rather than a boolean, `Authenticated<T, R>` and the
  new `RequirementsOf<T>` carry the exact requirements at the type level, and the
  registry is a `WeakMap` under `Symbol.for("@btravstack/contract/requirements")`
  — a new key, so a mismatched copy of the package reads a node as _unmarked_ and
  fails closed rather than calling `.has()` on it and getting an accidentally
  correct answer.

  `@btravstack/http-server` gains **`defineHttp`**, the one door:

  ```ts
  export const api = defineHttp({
    authenticators: { user: userAuth, service: serviceAuth },
  });
  ```

  It hands back `HttpController`, `HttpRouter` and `authenticators`, all typed by
  a scheme registry **inferred from the authenticators** rather than declared a
  second time. Declaring a scheme and implementing it are the same act, so a
  scheme without an authenticator is not a state the API can reach. Hold the
  result as **one binding and never destructure it**: each destructured member
  expands to a type mentioning `@btravstack/contract`'s inaccessible
  `unique symbol` (TS2527), while held whole it collapses to the nameable
  `Http<A>` — so an application writes **no type annotation at all**, which is
  what removed the three hand-written ones the previous shape required.

  **The principal follows the requirements.** A leaf whose requirements name one
  scheme gets the identity **bare** — byte-for-byte what handlers wrote before.
  A leaf naming several gets `{ scheme, identity }`, narrowed with a `switch`
  whose missing arm is a compile error. A public leaf gets `never`, so reading it
  cannot compile.

  **Scopes are declared in the contract and enforced before dispatch.**
  `HttpAuthenticator<P, Scope>()` states a scheme's scope vocabulary, so a
  credential reports what it actually granted through the new
  **`granted(identity, scopes)`** (`Granted<P, Scope>` is `P` bare when there is
  no vocabulary, and the branded `Grant<P, Scope>` when there is one) and the
  starter compares it against what the endpoint declared: a valid credential lacking a required scope is **`403`**,
  no valid credential at all is **`401`**, and neither carries a message. A
  `Defect` from an authenticator short-circuits rather than falling through to
  the next scheme — a broken verifier must not promote every caller. `granted()`
  is **mandatory rather than advisory**: the type parameter is erased at
  runtime, so the module-private symbol it stamps is the only sound way the
  starter can tell a scoped answer from an identity that merely carries a
  `scopes` field — the ordinary JWT-claims shape, which a structural test read
  as the scoped answer and handed the handler `undefined`.

  A router now declares **one di dependency per scheme its contract names**, on a
  port whose id carries the scheme name (`HttpAuthenticator:user`), so a missing
  authenticator is di's own unmet need naming that port. `HttpModule` wires the
  authenticator providers itself, off the router that carries them.

  **Breaking.** The top-level `HttpRouter` export is gone — it comes off
  `defineHttp` now, because that is where the registry that types it is stated;
  so do `HttpController` and `HttpAuthenticator`'s applied form. Also removed:
  `httpAuth`, `HttpAuth`, `HttpControllerOf`, `HttpRouterOf`,
  `HttpAuthenticatorOf`, `AuthenticatorPort`, `noAuthenticator`, the
  `HttpModuleOptions.authenticator` option and the router/authenticator identity
  comparison it carried. `authenticated(node)` must become
  `authenticated({ scheme: [] })(node)`.

  **Not modelled, deliberately.** AND within one requirement — a requirement
  names one scheme, because requiring two credentials at once would put a record
  rather than an identity on the handler; a composite scheme models it where it
  is genuinely needed. And OpenAPI document metadata (`type: http`,
  `bearerFormat`, an OAuth flow), which belongs beside the contract rather than
  in this factory.

- 4bc4669: The traces-and-metrics half of observability ships, as the deferred design
  prescribed. `@btravstack/observability/otel` — with `@opentelemetry/api` and
  `@opentelemetry/sdk-node` as optional peers, the `pino` protocol — exports
  `Tracer` and `Meter` ports over a `NodeSDK` held as a resourceful provider
  whose `release` flushes (a lost flush is a `teardownError` and exit `2`,
  never silence), and `UnitSpanModule`, a `StartOptions.unit` module opening a
  span per kernel unit with the ambient record's `unitId`/`traceId`/`tenantId`
  as attributes. Configuration is the SDK's own `OTEL_*` conventions — no
  config slice. Inbound, `@btravstack/http-server` and `@btravstack/amqp-worker` honour a
  W3C `traceparent` (trace-id field only, outranking `x-request-id` and
  `messageId`); `@btravstack/temporal-worker` deliberately keeps the workflow id as
  its correlation.
- b8fdee9: The `Unmet` type is gone from `@btravstack/di`

  Its documented purpose — a shaped module re-declaring the gates with it — was
  impossible to serve: declaration emit keeps the alias unreduced, and the
  unreduced form names imported modules' internal ports (TS2883 on the first
  consumer that exports a composition root), which is why every in-repo sugar
  already inlined the computation instead. Inline it; `NeedsGate` is unchanged
  and still exported.

  Internal trims alongside, none of them surface: `@btravstack/http-server` no longer
  memoises scheme ports (di resolves by id, so a fresh class per call is the same
  lookup — measured), and `HasMark`, `authenticatorPort` and `Http.authenticators`
  now carry TSDoc naming the external consumer each exists for, so their lack of
  an in-repo caller stops reading as dead surface.

- d5be140: `Runtime.needs` is `Runtime.resolves`

  Two different `needs` in one framework was one too many. di's `Module` has a
  `needs` — what a composition root supplies it — and the kernel's `Runtime` had
  one too, meaning something else entirely: the ports the runtime reads back out
  of the built application context. They never appear in the same object, which
  is exactly why the collision was easy to miss and easy to misread.

  ```ts
  const runtime: Runtime<typeof Clock> = {
    name: "ticker",
    resolves: [Clock],
    start: (host) => OkAsync(serving),
  };
  ```

  The type parameter is `Resolves` rather than `Needs` throughout —
  `Runtime<Resolves, Info>`, `RuntimeHost<Resolves>`, `RunUnit<Resolves>` — and
  `start`'s gate sentence follows:
  `"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.

  Every shipped runtime declares `resolves: []`, so an application that composes
  `http()` / `temporal()` / `amqp()` and never writes a runtime by hand is
  unaffected. A **hand-rolled** runtime renames one field.

  The array is still never read at run time — it exists so `Resolves` is
  inferable from the value, and `start`'s gate checks it against the module's
  exports.

- 3bf4036: A contract may name a scope only if its scheme can grant it

  `HttpRouter(contract)` now refuses a contract declaring a scope outside the
  vocabulary its scheme's authenticator was minted with, and the diagnostic ends
  on the offending scope:

  ```
  Property '"UNGRANTABLE SCOPE — its scheme's authenticator cannot grant it"' is
    missing in type 'Authenticated<…, [{ user: ["order:export"] }]>' but required
    in type '{ readonly "UNGRANTABLE SCOPE — …": "order:export"; }'
  ```

  Before this, nothing tied a contract's scope **strings** to what a scheme could
  actually grant. A typo — or a scope asked of a scheme declared with no
  vocabulary at all — compiled, passed every check, and then refused every caller
  on that route with a permanent `403` and no diagnostic anywhere.

  A requirement naming no scopes costs nothing, which is the common case. The
  check is the sibling of the scheme-**name** check di already performs by leaving
  an unknown scheme's port unmet.

- e0c567b: **Renamed.** `@btravstack/http` → `@btravstack/http-server`,
  `@btravstack/temporal` → `@btravstack/temporal-worker`, and
  `@btravstack/amqp` → `@btravstack/amqp-worker`.

  Each package claimed a whole transport and delivered the serving half of it:
  the calling half is `@orpc/client`, `@temporal-contract/client` and
  `@amqp-contract/client` today, and will be a `-client` package in this family
  later. Qualifying the name now reserves that space and matches the neighbours,
  which qualify both sides (`@orpc/server` / `@orpc/client`).

  "worker" rather than a uniform `-server` because it is Temporal's and AMQP's
  own word — and because `temporal-server` already means the Temporal Service
  itself.

  To migrate: change the specifier. Nothing else moved — no export was renamed,
  added or removed.

  ```diff
  -import { HttpModule } from "@btravstack/http";
  +import { HttpModule } from "@btravstack/http-server";
  ```

### Patch Changes

- 4499df1: A comment earns its line, or it goes

  A quarter of the TypeScript in this repository was comment, and one line in ten
  an inline essay — so a reader looking for the code had to skim past the reasons
  for it. `CLAUDE.md`'s "comment density: sparse" bullet now carries a test: a
  comment earns its line only if it guards a specific line against a plausible
  "simplification", states a symbol's contract as TSDoc, is a directive with a
  reason, or is a `GIVEN`/`WHEN`/`THEN` marker.

  No API changes. What consumers see is the TSDoc these packages ship in their
  declarations: shorter, and stating each symbol's contract rather than the
  history behind it, which lives in the repository and on the documentation site.

- fc38b9a: The README samples compile again — and now cannot stop. Every `ts` fence in
  the package READMEs, the root README and the documentation site is extracted
  into generated type-test modules and compiled by `pnpm typecheck`. The sweep
  that built the gate fixed the drift it found: the amqp and temporal READMEs'
  two-argument `execute` from before the branded tenant, a wrong consumer key,
  a missing error-triage arm, and the pre-`defineHttp` router spelling in the
  root README.
- 758c539: Each runtime README carries an `## Options` index: one line per option —
  `connectionOptions`, `defaultConsumerOptions` and `connectTimeoutMs` were
  documented nowhere an npm consumer could see — with the reference page as
  the one detailed home for defaults and reasoning.
- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.
- 65f022f: Refuse a contract key containing a literal dot, at compile time, instead of
  serving it as a 404.

  A piece's path is joined and split on `.`, so `nest` could not tell a path
  **separator** from a dot **inside** one contract key. A contract keyed
  `{ "a.b": oc }` therefore minted a piece at `"a.b"`, passed coverage, rebuilt
  as `{ a: { b: fn } }`, and was then discarded by `routerOf`'s stray-key drop —
  a fully green compile and a route that 404s, which is the failure class this
  stack exists to delete rather than document.

  Both ends are closed now. `ControllerKeyOf` drops dotted keys at **every**
  level, so such a piece is never mintable; and `HttpRouter(contract)([...])`
  refuses a contract whose **top** level carries one against
  `"UNSLICEABLE CONTRACT KEY — …"`. That marker is reported ahead of
  `"UNCOVERED CONTROLLERS — …"` deliberately: _no piece can name this_ is a
  different fact from _no piece did_, and only the first one tells you the array
  form is the wrong tool. The sentence points at the `(deps, arm)` form, which
  splits nothing and serves such a contract correctly — the escape hatch is
  real and stays open.

  Only the **top** level is fatal. A piece minted at a dotted key's parent hands
  its implementation record to `routerOf` whole, and that walk splits paths,
  never the keys underneath them — so `{ v1: { "a.b": oc } }` still composes
  from a piece at `"v1"`, and the gate does not over-reach onto it.

- Updated dependencies [e8236b2]
- Updated dependencies [4499df1]
- Updated dependencies [6f964fa]
- Updated dependencies [76f58c4]
- Updated dependencies [41aa1fb]
- Updated dependencies [fc38b9a]
- Updated dependencies [9af980d]
- Updated dependencies [ccdcc32]
- Updated dependencies [54de3fa]
- Updated dependencies [82579e8]
- Updated dependencies [f615282]
- Updated dependencies [b8fdee9]
- Updated dependencies [31f70f7]
- Updated dependencies [d5be140]
- Updated dependencies [3bf4036]
- Updated dependencies [74621a1]
  - @btravstack/contract@0.3.0
  - @btravstack/di@0.3.0
  - @btravstack/config@0.3.0
  - @btravstack/core@0.3.0

## 0.2.0

### Minor Changes

- f133934: **Configuration, the twelve-factor way, in its own package.** `@btravstack/config`
  exports `Env` — the environment as a port, which `@btravstack/core` provides to
  every graph `start` boots (`process.env`, or `StartOptions.env` for a test) —
  and `Config`:
  `Config.string/integer/port(variable, { default?, min?, max? })` fields,
  `Config.object({...})` composing them into a Standard Schema over the
  environment (any other Standard Schema, a `zod` object over the raw variables
  for instance, is accepted too), and `Config.provider(Port)(schema)` binding a
  port from `Env` — a modeled `ConfigInvalid` naming every offending variable
  when the environment is wrong, which `runMain` maps to sysexits(3)'s
  `EX_CONFIG` (78) rather than the generic startup `1`. The kernel binds its own
  `PROBE_PORT` the same way (default `9000`; `probes` still overrides), and a
  startup failure of any kind is now reported as a `startFailed` kernel event
  before `stopping`, so a bad environment is named on stderr instead of exiting
  silently. An empty or blank variable is an error, never an absent one; `PORT=0`
  stays expressible.

  `@btravstack/http-server` becomes a starter: `http()` provides
  `HttpRuntime` and `HttpConfig`, bound from `PORT` (default `3000`) and `HOST`
  (default `0.0.0.0`) unless pinned (`http({ port: 0 })` for a test —
  explicit beats environment beats default, per field, through
  `Config.pinned(value, field)`; a pinned field reads nothing from the
  environment, and the module's declared `Env` need and `ConfigInvalid` stay
  whatever is pinned). `RuntimeNeedsGate` is renamed `StartGate`, since it now
  also states `NO RUNTIME`.

  `Config.provider("Name")(schema)` — the name form — mints the port (its
  service is the schema's output) and returns the provider carrying it typed
  (`provider.port`), the shape for a slice that is one application's own; the
  class form `Config.provider(Port)(schema)` stays for a slice that is public
  API another package names. Config is the one sugar that takes a name — several
  config slices per application is normal, and the name is what `ConfigInvalid`
  prints; the starters' `HttpRouter` / `TemporalActivities` / `AmqpHandlers`
  provide the starter's own fixed port and take none.

- ee6c612: **Breaking.** `@btravstack/http-server` is the HTTP starter, and there is one way HTTP
  is answered: **oRPC, over its own node adapter**. `http()` mounts the
  application's router under `prefix` (default `/rpc`) and provides the runtime
  on **`HttpRuntime`** (declared over core's `RuntimePort`, `Runtime<never,
HttpInfo>` — no `needs`), which the composition root imports and exports so
  `start` finds it. The router is not an option: it is a **provider on the
  starter's own router port** — one id, `Port("HttpRouter")`, framework-owned
  like `HttpConfig`, since a process serves one router as it boots one runtime —
  whose service is a context-free oRPC router built from the use cases its
  procedures call. The starter **needs** that port through di, so a composition
  that imports it without providing a router is refused at `start`, at compile
  time; two router providers in one graph are di's duplicate-provider defect at
  build.

  ```ts
  const orderRouter = HttpRouter(orderContract)([PlaceOrder, FindOrder], {
    sync: (place, find) => ({ orders: { place: …, find: … } }),
  });

  const OrderApi = Module("OrderApi")({
    imports: [ApplicationModule, PersistenceModule, http()],
    provides: [orderRouter],
    exports: [HttpRuntime],
  });
  ```

  `@btravstack/orpc` is folded into this package and no longer exists. `needs`,
  `handler` and `router` are gone from `HttpOptions`; `httpRuntime` is no longer
  exported; the node listener port `HttpHandler` is internal — an application
  provides a router, never a handler, and a handler built per request by the
  `StartOptions.unit` module is gone with it. An unmatched path is declined
  unwritten by oRPC and answered by the runtime's own `404`, and a defect inside
  a procedure is oRPC's own `INTERNAL_SERVER_ERROR`; `Result` → HTTP status
  stays the router's `.result()` triage. `@orpc/server`, `@orpc/contract` and
  `@unthrown/orpc` are peer dependencies — not `hono` or `@hono/node-server`,
  which routed one pattern to oRPC's fetch adapter and are gone.

  **`HttpModule(name)({ router, prefix?, port?, hostname?, imports?, provides?, exports? })`**
  is the way an application declares an HTTP deployment: `Module(name)({...})`
  plus the router **provider**. It imports the starter, provides the router,
  exports `HttpRuntime`, and hands the augmented imports/provides/exports to
  di's own `Module(name)({...})`, whose return type is the sugar's — sugar over
  the same primitives, nothing new for the kernel or the gates. `router` is a
  plain `Provider` on the starter's router port, which is what `HttpRouter`
  returns. `http()` stays exported as the primitive it delegates to.

  `HttpRouter(contract)(deps, { sync })` — contract-first: `sync` returns a
  record shaped like the contract whose leaves are plain `Result`-returning
  functions (the `.result()` handler `@unthrown/orpc` gives an implementer),
  typed by the contract at the call; `implement`, `os.…`, `.result(...)` and
  `os.router(...)` are done for you. It is di's own `Provider(port)` on the
  starter's router port — no name to give, no class line — returning the
  provider with the port typed (`orderRouter.port`, di's
  `PortClassOf<"HttpRouter", Router<…>>`) for a hand-declared provider or a
  type test; `HttpModule({ router: orderRouter })` takes it from there.
  `@orpc/contract` and `@unthrown/orpc` join the peers.

- 2f1974e: The HTTP runtime for `@btravstack/core`.

  `httpRuntime({ port, needs, handler })` owns an HTTP server's lifecycle and
  nothing else: it binds (publishing the real port on `Serving.info`, so
  `port: 0` is usable), opens one kernel unit per request, drains by genuinely
  refusing new work, and stops by destroying what is left.

  Its guarantee is that every request produces exactly one completed response,
  and the unit stays open until that response is on the wire — which makes the
  kernel's least-checkable contract structural rather than documented. Routing,
  middleware and `Result` → HTTP status are deliberately not included: bring an
  oRPC router (see the starter entry below).

### Patch Changes

- d3564a9: Two consequences of the kernel's new `StartOptions.unit`. A unit whose work
  begins after its response has already closed — a client that hung up during a
  slow per-request build — now settles at once instead of waiting for a `'close'`
  event that already fired, which held the unit open for the process lifetime.
  And a defect that never reaches the handler's promise — a synchronous throw, or
  a unit provider that failed to build — now answers `500` when no headers are
  out, rather than only resetting the connection.
- Updated dependencies [f133934]
- Updated dependencies [9ca73c5]
- Updated dependencies [ba815e4]
- Updated dependencies [38d7cd5]
- Updated dependencies [4fa693c]
- Updated dependencies [b56501f]
- Updated dependencies [e616e23]
- Updated dependencies [5a271c0]
- Updated dependencies [72b8fbd]
- Updated dependencies [e950473]
- Updated dependencies [068399d]
  - @btravstack/config@0.2.0
  - @btravstack/core@0.2.0
  - @btravstack/di@0.2.0
