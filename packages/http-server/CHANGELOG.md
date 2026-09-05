# @btravstack/http-server

## 0.13.0

### Minor Changes

- 8c03f9a: Server-sent events are supported through the HTTP starter. An open
  `text/event-stream` response whose headers have flushed is reset when the
  drain begins, at beat 3's start, so the client reconnects to a replica that
  is staying and the unit is counted `completed` rather than `abandoned`. `GET`
  is admitted on a procedure whose output is an event iterator, which is the
  one request a browser's `EventSource` can send.
- 4808582: **Breaking.** `StartOptions.unit` is removed. A runtime forks the unit scope
  itself: a unit's work receives a `UnitHost` — `{ ctx, fork }` — and
  `fork(module, seed)` builds `module` the runtime chose over the application
  context plus a seed, torn down by the kernel when the unit settles, inside
  the unit as before.

  Each starter binds its own module instead, on its own options —
  `http({ unit: { anonymous } })`, `amqp({ unit: { message } })`,
  `temporal({ unit: { activity } })` — and forks it where it handles the
  request, the delivery or the activity. There is no separate gate for a bound
  module's own unmet needs: they join the starter's ordinary `Needs` channel,
  exactly like an import's, and surface through `start`'s existing
  `UNSATISFIED DEPENDENCIES` diagnostic.

  `HttpAnswerer.handle` gains a fourth parameter, `host: UnitHost<never>` —
  appended rather than inserted, so an answerer that does not fork is unchanged.
  `testRuntime` is generic over the module bound on `unit`, and what that module
  needs joins `TestRuntime.module`'s own `Needs`, so a test composition that
  cannot satisfy it is refused at `start` rather than on the first `submit()`.

  `Module.forkScope` accepts a typed `seed` — entries seeded from outside the
  module tree are subtracted from the gate the same way the parent's own
  exports are — though no starter seeds anything yet; each forks with `[]`.
  `testRuntime(name, { unit })` forks per submitted unit; `bootFixture` no
  longer takes `unit`.

  `UnitSpanModule` moves with them: it is no longer composed as `start`'s
  `unit`, but bound on a starter's own option — `unit: { anonymous:
UnitSpanModule }` — and forked by the runtime around every unit it opens.

  Behaviour change: both HTTP answerers now fork **exactly once dispatch has
  cleared every guard**, so a request that never reaches a handler never opens
  a unit scope — the runtime's own `404`, a request oRPC's schema refuses before
  dispatch, one `principalMiddleware` refuses, and an htmx request refused by
  auth or by body validation. For a consumer whose unit module provides a
  request-scoped logger, those four now log nothing where they used to log a
  request's worth of lines.

- 79b07ec: **Breaking.** A unit is opened under a KIND, and the kind's own module is what
  the runtime forks — seeded with what the unit was opened for, and read back by
  a leaf through `context.unit`.

  **`defineHttp` is two steps now.** `defineHttp({ authenticators })` mints one
  principal port per declared scheme, on `auth.principals`, and a second call —
  `auth.units<{ anonymous: typeof A; user: typeof U }>()` — retypes the **same
  object** by the module each kind binds. The kinds arrive on a second call for a
  reason a single call cannot have: a unit module names
  `auth.principals.<scheme>`, so its type depends on `typeof auth`; if `auth` in
  turn depended on the modules the kinds bind, the two would be mutually
  recursive and TypeScript reports `TS7022`. Nothing is rebuilt, and an
  application that never calls `units<…>()` is unchanged. `principalPort`,
  `Principals`, `Kinds` and `UnitsOf` are exported.

  **`unit` is a record of kind → module** on `http()`, `httpServer()` and
  `HttpModule` — `anonymous` for a leaf that asked for no credential, else the
  scheme that resolved one. A scheme that binds no module **falls back to
  `anonymous`**, so `unit: { anonymous: RequestModule }` keeps its meaning and a
  graph binding only that needs no change. A request forks nothing only when the
  scheme and `anonymous` both bind no module. The fallback is deliberate: an unbound kind forking nothing would
  make every existing application silently lose its request scope on precisely
  its authenticated procedures.

  **`context.unit`, on all three transports.** Every piece — and every
  whole-record composer beside it: `OrpcController`, `OrpcRouter`,
  `AmqpHandler`, `AmqpHandlers`, `HtmxGet`, `HtmxPost`,
  `TemporalWorkflowActivities`, `TemporalActivities` — takes an optional
  `unit: { name: Port }` beside `inject`, declared once, and every leaf reads it
  as `context.unit.name`. On HTTP the record is filtered **per leaf** by the kind
  that leaf's own requirements select, with the `anonymous` fallback applied per
  scheme: a name the kind's module does not export is not a property, so reading
  it is TypeScript's own "property does not exist", and a leaf accepting several
  schemes keeps only what every one of their modules exports. Entries are lazy
  getters over the fork. A piece that declares no record compiles unchanged, and
  `context.unit` is `{}`.

  **Two seed ports.** `AmqpMessage(contract)` carries the validated delivery and
  `ActivityInput(contract)` the validated activity input; HTTP seeds
  `auth.principals[scheme]` with the identity that scheme resolved, whichever
  module ends up forked. A unit module naming a seeded port owes the composition
  root nothing for it — it is subtracted from what the starter reports — while
  everything else it needs still surfaces at `start`'s
  `UNSATISFIED DEPENDENCIES`.

  **Three gates.** `HttpModule` refuses a kind no request can open under, against
  `UNDECLARED UNIT KIND — …`: the bindable set is the kinds `units<…>()` declared
  when an answerer carries them — the router and the fragments both do, so a
  fragments-only root is gated the same way — else `anonymous` plus every scheme
  the answerers serve, read off their own authenticator ports. `AmqpModule` and
  `TemporalModule` refuse a bound module that does not export a port some piece —
  or the whole-record arm — injects, against `UNIT DOES NOT PROVIDE — …`, naming
  the port, including the case where no module is bound at all.

  **Signature changes beyond the added option.** `FragmentAnswer.handle` takes the
  handler's whole `context` object rather than the bare principal: it was
  `handle(principal, params, input)` and is now
  `handle({ principal, unit }, params, input)`. `AmqpHandler(contract, key)`,
  `TemporalWorkflowActivities(contract, key)` and the record arms of
  `AmqpHandlers(contract)` and `TemporalActivities(contract)` take
  `{ inject, unit?, sync }` rather than di's whole arm set — `value` **could**
  have carried the same record, since the options are each package's own and the
  declared record is what types it either way, and it was dropped so one arm reads
  the same as `@btravstack/http-server`'s `OrpcController` and `OrpcRouter` on all
  three transports.
  The record arm gives up di's `value`, `async` and resourceful forms for the whole record on all three transports; nothing in the repository needs one there, and a hand-written `Provider(port)` over the composer's port still works.

  **`http()`, `httpServer()`, `amqp()` and `temporal()` stay un-gated**, and
  structurally so: each takes its router, handlers or activities as a **need**,
  never as a value, so there is nothing to check a bound `unit` against. Their
  option keeps the wide record. A hand-rolled composition that wants the gate
  composes through `HttpModule`, `AmqpModule` or `TemporalModule`.

### Patch Changes

- Updated dependencies [3f48955]
- Updated dependencies [4808582]
  - @btravstack/contract@0.13.0
  - @btravstack/core@0.13.0
  - @btravstack/di@0.13.0
  - @btravstack/config@0.13.0

## 0.12.0

### Patch Changes

- 97314ca: `traceIdOfTraceparent` is `@btravstack/core`'s, beside `releasedBy`.

  The parser was duplicated verbatim in `@btravstack/http-server` and
  `@btravstack/amqp-worker` — the same shape issue #24 hoisted `releasedBy` for.
  Every transport carrying an inbound trace needs the same answer, and two copies
  of a parser is two places for the all-zero rule to be forgotten.

  It takes the trace-id field and nothing else: the parent's **span id is
  dropped**, because `UnitMeta.traceId` is a correlation id rather than a span
  context, and an all-zero trace id is the specification's own "invalid" and is
  refused like a malformed header. A runtime pairs it with the rule its own
  headers need — adopt only a non-blank inbound id, since `traceId` defaults to
  `meta.id` when it is nullish and `""` is not.

  No behaviour changes in either runtime; the export is new.

- Updated dependencies [97314ca]
  - @btravstack/core@0.12.0
  - @btravstack/config@0.12.0
  - @btravstack/contract@0.12.0
  - @btravstack/di@0.12.0

## 0.11.0

### Patch Changes

- 4f6dc0b: An array gate names the missing key at every arity, and stands down when a
  piece's mint was already refused.

  The refusal was a fixed two-element tuple `[marker, missingKey]`, so TypeScript
  lined an array up against it — and named the key — only when the array happened
  to be two elements long. At one or three, the diagnostic carried the marker
  alone and the developer diffed the contract against the array by hand. It is now
  a tuple **as long as the array the caller wrote**: its head the caller's own
  elements, which match, and its last element the marker paired with what is
  missing. Measured on a one-element array:

  ```text
  … is not assignable to type 'readonly ["UNCOVERED HANDLERS — the contract declares a consumer this array does not cover", "right"]'.
  ```

  `UNCOVERED CONTROLLERS`, `UNCOVERED HANDLERS`, `UNCOVERED ACTIVITIES`,
  `OVERLAPPING CONTROLLERS` and `UNSLICEABLE CONTRACT KEY` all take the shape.

  **`@btravstack/http-server` gains a second fix.** A typo'd mint —
  `OrpcController(contract, "billing")` on a contract with no `billing` — is a
  `TS2345` listing every valid path, and the value TypeScript hands back is typed
  from the parameter it rejected, so its key reads as _all_ of them at once. That
  union contains `"v1"` and `"v1.orders"`, which is exactly what `Overlapping`
  refuses, and the router call then reported `OVERLAPPING CONTROLLERS` where
  nothing overlapped: first error right, loudest error wrong. Both array gates now
  stand down when an element's key is a union — the program does not compile
  either way, and the mint's own error is the one to read.

  New page: [Read a wiring error](https://btravstack.github.io/btravstack/how-to/read-a-wiring-error)
  — where the actionable sentence is, why the line is wide, what each marker
  means, and the two `TS4023` lines an application can turn off.

  Closes #204.

- Updated dependencies [f3cc6d5]
- Updated dependencies [f3cc6d5]
- Updated dependencies [51e67bd]
  - @btravstack/config@0.11.0
  - @btravstack/core@0.11.0
  - @btravstack/contract@0.11.0
  - @btravstack/di@0.11.0

## 0.10.0

### Minor Changes

- 54a4c6e: Two authenticators ship, so an application stops writing them by hand — the one
  area of this framework where "the application writes it" carries a security cost
  rather than a keystroke cost.

  `apiKeyAuthenticator<P>()({ keys })`, on the main entry point: a constant-time
  compare over SHA-256 digests, every configured key checked with no early return,
  and a missing header on the same path as a wrong one.

  `jwtAuthenticator<P>()({ jwks, issuer, audience, principal, scopes? })`, from
  `@btravstack/http-server/jwt` with `jose` as an optional peer: JWKS fetch, cache
  and rotation; an asymmetric-only algorithm allowlist, because a JWKS publishes
  public keys and accepting `HS256` beside them is the algorithm-confusion attack;
  `iss`, `aud` and `exp` required to be present — jose validates `exp` only when
  it is, so without that a signed token omitting it authenticates and never
  expires — with `nbf` honoured when present and clock tolerance defaulting to
  zero. Each scheme's scope vocabulary is inferred from what it grants, so it
  cannot name a scope nothing issues. Every failure is the same refusal, so the endpoint is not an oracle.

  Both are ordinary `Authenticator` values bound by name in
  `defineHttp({ authenticators })`, and a grant goes through the existing scope
  walk — no new checking surface. Password hashing and credential issuing are
  explicitly out of scope: both of these are on the verifying side.

- dfc126f: Observability is a set port now, and the `instrumented` flag is gone from every
  package that had one.

  `@btravstack/core` declares `Observers`, `observe` and `noObserver`. A starter
  reports what it did — an operation, then how it settled — and holds no `Logger`,
  `Meter` or `Tracer` of its own. `@btravstack/observability` contributes the
  member that writes a failure as a line; `@btravstack/observability/otel`
  contributes the one that opens the span and mints
  `btravstack.<component>.operations` and `.duration`.

  **The three servers gain RED metrics** they never had — rate, errors and
  duration per request, delivery and activity attempt, at the unit seam.

  **`instrumented` is removed, not deprecated**, from `http()`, `amqp()`,
  `temporal()`, `cache()`, `mailer()`, `storage()` and `prismaDatabase()`. It
  defaulted to `true` and put three ports in each module's `Needs`, so a root that
  wanted a cache and no OpenTelemetry SDK got a compile error naming them and had
  to pass an option to turn off something it never asked for. Now every one of
  those modules owes nothing beyond its adapter's own needs, and composing
  `observability()` and `otel()` is what turns the lines and the instruments on —
  with no call site to change.

  Two behaviour changes worth knowing:

  - **A successful operation writes no log line.** That is what the metric is
    for. `@btravstack/mailer` loses its `info` "mail sent" as a result; an
    application that wants an operator to see every send writes that line where it
    sends.
  - **`@btravstack/prisma` needs `Env` and `Logger`** — `Logger` for exactly one
    line, the `debug` saying engine tracing is off because `@prisma/instrumentation`
    is absent. That is a startup fact rather than an operation, so no observer can
    settle it.

### Patch Changes

- 9500292: The README install lines now pin the beta majors. `@orpc/*`,
  `@temporal-contract/*` and `@amqp-contract/*` each ship a `latest` dist-tag
  pointing at an older major, so the unversioned line installed the wrong one and
  the first run failed in type errors.
- Updated dependencies [dfc126f]
  - @btravstack/core@0.10.0
  - @btravstack/config@0.10.0
  - @btravstack/contract@0.10.0
  - @btravstack/di@0.10.0

## 0.9.0

### Minor Changes

- 22a90fc: feat(di)!: a provider declares its dependencies as a required `inject` key

  `Provider(Port)(deps, arm)` is now `Provider(Port)({ inject: deps, ...arm })`,
  one signature instead of two overloads discriminated by argument count. Every
  mint built on it moves with it — `Provider.member`, `Config.provider`,
  `api.OrpcController`, `api.OrpcRouter`, `api.HtmxGet`/`HtmxPost`,
  `HttpAuthenticator`, `AmqpHandler`/`AmqpHandlers`,
  `TemporalWorkflowActivities`/`TemporalActivities`. The array-of-pieces arm on
  the three composing forms is unchanged.

  `inject` is **required**. Optional, a mistyped key (`injec:`) is not caught by
  excess-property checking inside the arm union, so it would silently become a
  no-deps provider and fail later as di's unmet-dependency defect instead of at
  the call; required, the diagnostic names the property. A provider with no
  dependencies writes `inject: {}`, and its factory is handed one empty services
  record rather than no arguments.

  Migration is mechanical:

  ```diff
  -Provider(OrderRepository)(
  -  { db: OrderDatabase },
  -  { sync: ({ db }) => prismaOrderRepository(db) },
  -);
  +Provider(OrderRepository)({
  +  inject: { db: OrderDatabase },
  +  sync: ({ db }) => prismaOrderRepository(db),
  +});

  -Provider(AppConfig)({ value: { dbUrl } });
  +Provider(AppConfig)({ inject: {}, value: { dbUrl } });
  ```

### Patch Changes

- Updated dependencies [22a90fc]
  - @btravstack/di@0.9.0
  - @btravstack/config@0.9.0
  - @btravstack/core@0.9.0
  - @btravstack/contract@0.9.0

## 0.8.0

### Minor Changes

- 525ab53: htmx fragments: a second `HttpHandler` answerer, serving `Html` escaped by default.

  `html`/`raw` (`Html`, an object rather than a bare string) escape every
  interpolation by default; `raw(markup)` is the one way past the escaping, a
  visible act at the call site. The escaping is context-blind: it protects
  element text and a quoted attribute value, and nothing else — an unquoted
  attribute, an attribute name, a URL scheme and `<script>`/`<style>` contents
  are the caller's own responsibility.

  `api.HtmxGet(path, options?)` and `api.HtmxPost(path, options?)` mint a route
  straight from its path — no contract in between. `options.requires`, typed
  exactly as an oRPC procedure's `authenticated()` mark, gives a route the same
  principal and the same 401/403 path as a procedure. It is **not** an oRPC
  contract: a browser navigation is not an RPC call, so a route answers `Html`
  rather than a typed envelope, and its errors are the slice's own to recover
  into a rendered fragment rather than a declared union a client branches on.
  `HtmxPost` additionally takes `options.input`, the Standard Schema that
  validates the decoded form body. `ParamsOf<Path>` extracts a path template's
  `:name` segments at the type level.

  `api.HtmxFragments([piece, …])` composes an array of `HtmxGet`/`HtmxPost`
  pieces into one port, keyed by index. `htmx({ prefix? })` is the answerer, a
  second `HttpHandler` member alongside `orpc()`.

  `HttpModule({ router?, fragments?, fragmentsPrefix?, … })` composes a router,
  fragments, or both — supplying neither is refused at the call against a
  "SERVES NOTHING" gate. A scheme shared between the two is deduplicated by
  reference before it reaches `provides`; `HttpModuleOptions`'s leading generic
  parameters go from three (`RouterError, RouterNeeds, Auth`, when `router` was
  required) to two (`Router, Fragments`, both optional) for this.

  Limitations ship stated rather than discovered: the POST body decodes through
  `Object.fromEntries`, assumed `application/x-www-form-urlencoded` with no
  `content-type` check, so a `<select multiple>` or a checkbox group keeps only
  the last value and a JSON body reads as one garbage key; route order is the
  composition root's — an unmarked route declared before a marked route whose
  path can also match the same request answers it, with no authentication run;
  a route always answers `200` on success, so `HX-Redirect`, `HX-Trigger`,
  `HX-Retarget` and `HX-Reswap` are unreachable and a route cannot answer its
  own `404` or `422`; and every `200` carries `Cache-Control: no-store`,
  unconditional, since the package has no way to know a route's output is safe
  for a shared cache to keep.

- a38697e: The authentication walk and the socket half are reusable by a second answerer.

  `resolvePrincipal(requirements, authenticators, headers)` is the walk oRPC's
  `principalMiddleware` used to hold — requirements in declared order, the scope
  comparison, the grant brand test — answering an `AsyncResult` instead of
  calling oRPC's `next()`. `principalMiddleware` is now the oRPC adapter over it.
  A second protocol therefore shares one scope check rather than copying it.

  `httpServer(options)` is the socket, runtime and configuration with **no**
  answerer; `http(options)` is `httpServer(options)` plus `orpc(options)` and is
  unchanged in both behaviour and signature. This is what makes a graph serving
  only fragments expressible: it would otherwise have had to compose `http()`
  and declare an oRPC router it does not have.

  `UnderScoped` is exported: the `403` case, distinct from `Unauthenticated`'s
  `401`. It was already tracked inside the walk and collapsed at the end.

- 06ba8c7: `HttpHandler` is a set port, so HTTP can carry more than one protocol.

  It was a single function, and its own TSDoc said why: "there is one way to
  answer HTTP here, oRPC, so nothing outside this package provides or names it."
  That was true of the package and is no longer the intent — GraphQL and htmx
  fragments are coming, and neither is an oRPC procedure.

  ```ts
  type HttpAnswerer = {
    readonly prefix: `/${string}`;
    readonly handle: (request, response, signal) => PromiseLike<unknown>;
  };
  ```

  Every protocol served in the process contributes one member, and the runtime
  routes each request to the one whose prefix matches **longest**. `/rpc` owns
  `/rpc` and everything under it; a `/` fragment answerer takes the rest.

  ## Why routing rather than a chain

  A graph holds exactly one runtime (thesis #1), so several protocols cannot be
  several runtimes — they are several answerers under one. The open question was
  how a request finds its answerer. A chain of "answer or decline" would have
  made ordering a property of provider registration across modules, visible in no
  single line, and would have needed the matched signal the port deliberately
  discards. Longest-prefix routing needs neither: nesting is the expected shape,
  so there is nothing to order.

  - A mount point is a **path segment**, not a string prefix — `/rpc` does not
    own `/rpcx`.
  - A trailing slash is the same mount, so `/rpc` and `/rpc/` collide, and two
    answerers on one mount is a `RuntimeStartFailed` at `listen` rather than a
    coin toss.
  - A path no mount covers is the runtime's own `404`, written before any
    answerer is consulted. A path a mount does cover, whose answerer declines, is
    the same `404` it always was — oRPC's behaviour is unchanged.

  ## What a composition root has to change

  **`HttpRuntime` now resolves `HttpHandler`**, because a member contributed by a
  sibling module is not visible from inside the starter's own — `resolves` is the
  kernel's existing mechanism for what a runtime reads out of the application
  context. So the root must export it:

  ```ts
  Module("OrderApi")({ imports: [http()], exports: [HttpRuntime, HttpHandler] });
  ```

  `HttpModule` adds it for you, and `start`'s `UNSATISFIED RUNTIME PORTS` names
  the port when a hand-written root forgets — that arm had no shipped starter
  declaring anything until now.

  `HttpHandler` is exported from the package for the first time, since a second
  protocol's package has to name it.

  ## An answerer outside a contract is public

  `@btravstack/contract`'s marker is what says which scheme protects an oRPC
  procedure. A GraphQL operation or an HTML fragment has no such statement, so
  its routes are public unless the answerer brings authentication of its own —
  exactly as an unmarked procedure is public, and with the same absence of a gate
  for "you forgot". What the common way across protocols should be is #179's
  question, and is deliberately not answered here.

- 6b6149a: `openApiDocument` answers through the Result channel, with options typed by
  the library.

  It returned a bare `Promise<OpenApiDocument>` — the one async surface in the
  family outside the documented exceptions — so a generator rejection escaped
  as a raw rejection with no defect channel. It now returns
  `AsyncResult<OpenApiDocument, never>`: async, and cannot fail, with a
  generator fault arriving as a defect. Extraction is `.get()`:

  ```ts
  const document = (await openApiDocument(contract, options)).get();
  ```

  `base` and `securitySchemes` were `Record<string, unknown>` bags — the
  untyped-passthrough shape this family bans, under which a key the generator
  ignores was silently inert. `base` is now `Partial<OpenApiDocument>` and
  `securitySchemes` the new `OpenApiSecuritySchemes` export, the document's own
  `components.securitySchemes` shape, so a wrong key is a type error.

- e749953: `HttpController` and `HttpRouter` are renamed `OrpcController` and `OrpcRouter`.

  A name is qualified by the half it implements — the rule that made the package
  `http-server` rather than `http`, applied one level down. `HttpHandler` became a
  set port carrying several protocols, and the oRPC pieces were the only ones
  still claiming the umbrella: the answerer factories were already `orpc()` and
  `htmx()`, and the htmx pieces were already `HtmxGet`/`HtmxPost`/`HtmxFragments`,
  while the oRPC pieces read as the transport's own. `HttpRouterPort` held an
  oRPC `Router` — the HTTP router is `HttpHandler`, which routes each request to
  the answerer whose prefix matches longest.

  The line the rename draws: `Http*` is the **transport** — `HttpRuntime`,
  `HttpModule`, `HttpConfig`, `HttpHandler`, `defineHttp`, `http()`, all
  unchanged — and a protocol prefix is **one answerer's pieces**,
  `OrpcController`/`OrpcRouter` beside `HtmxGet`/`HtmxPost`/`HtmxFragments`, and
  whatever GraphQL brings next.

  Migration is two identifiers, including the di port id `"HttpRouter"` and the
  controller port-id prefix `"HttpController:"`, which become `"OrpcRouter"` and
  `"OrpcController:"`:

  ```text
  api.HttpController(contract, path)  →  api.OrpcController(contract, path)
  api.HttpRouter(contract)([…])       →  api.OrpcRouter(contract)([…])
  HttpRouterPort                      →  OrpcRouterPort
  ControllerKeyOf / ControllerPortOf  →  unchanged
  ```

  The `"UNCOVERED CONTROLLERS — …"` and `"OVERLAPPING CONTROLLERS — …"` gate
  markers are unchanged: only the `Http` prefix was the lie, "controller" was
  never one.

- e34d7a8: htmx fragments: the contract kind is deleted, routes declare themselves.

  `defineFragments`, `FragmentRoute`, `FragmentsContract` and
  `api.HtmxController(fragments, key)` are gone. A contract earns a package
  when a client consumes it — an oRPC procedure gets one because `@orpc/client`
  reads it to build a typed call. A fragment has no client: a browser navigates
  and htmx swaps the response in, so there was never a consumer for the shape
  to serve.

  `api.HtmxGet(path, options?)` and `api.HtmxPost(path, options?)` mint a route
  straight from its path, `options.requires` typed exactly as an oRPC
  procedure's mark; `HtmxPost` also takes `options.input`, the Standard Schema
  that validates the decoded form body (`GET` has no `input` field at all).
  `api.HtmxFragments([piece, …])` composes an array of them, keyed by index
  rather than a contract's key space.

  Two gaps the contract shape carried are closed by this shape rather than
  patched: an ungrantable scope on `requires` now fails the same
  `"UNGRANTABLE SCOPE"` compile-time check an oRPC contract gets, checked at
  each route's own mint instead of only at runtime (#184) — narrowly: the gate
  fires on the literal `requires` given at the mint, and a value first widened
  to `Requirements`, or a route record hand-built without the factories,
  bypasses it and falls back to the runtime walk, a `403` rather than an
  admission; and a piece minted over a marked route composed under an
  unrelated unmarked slot has no second contract instantiation left to
  construct it from, so that hole closes by construction rather than by a new
  gate (#185).

### Patch Changes

- Updated dependencies [5783819]
- Updated dependencies [525ab53]
- Updated dependencies [a38697e]
- Updated dependencies [06ba8c7]
- Updated dependencies [e749953]
- Updated dependencies [e34d7a8]
  - @btravstack/core@0.8.0
  - @btravstack/config@0.8.0
  - @btravstack/contract@0.8.0
  - @btravstack/di@0.8.0

## 0.7.0

### Minor Changes

- 419a9d5: CORS, body limits and response compression are options on `http()` and
  `HttpModule` rather than `plugins` lines — and every framework scalar a
  deployment could reasonably vary is now a configuration field, pinned by its
  option.

  ```ts
  export const OrderApi = HttpModule("OrderApi")({
    router: orderRouter,
    cors: { origin: "https://orders.example", credentials: true },
    bodyLimit: 5_000_000,
    compression: true,
  });
  ```

  `true` takes the underlying oRPC plugin's own defaults; a record is that
  plugin's own options type verbatim — `CORSHandlerPluginOptions`,
  `ResponseCompressionHandlerPluginOptions` — never a `Record<string, unknown>`
  bag. `plugins` stays for every oRPC plugin these three do not name.

  ## Eight new variables, each pinned by its option

  The option is what a test or a settled decision fixes; the variable is what a
  deployment sets. `Config.pinned` decides between them per field — explicit
  beats environment beats default — exactly as `PORT` and `HOST` already worked.

  | Variable                                               | Default           | Bound by                                  |
  | ------------------------------------------------------ | ----------------- | ----------------------------------------- |
  | `PRE_DRAIN_DELAY_MS` / `DRAIN_TIMEOUT_MS`              | `5000` / `20000`  | the kernel                                |
  | `HTTP_BODY_LIMIT`                                      | `1048576`         | `http()` — `0` is unbounded               |
  | `HTTP_CORS_ORIGIN`                                     | unset (off)       | `http()` — a comma-separated list, or `*` |
  | `HTTP_COMPRESSION`                                     | `false`           | `http()`                                  |
  | `TEMPORAL_GRACE_PERIOD_MS` / `TEMPORAL_FORCE_AFTER_MS` | `10000` / `15000` | `temporal()`                              |
  | `AMQP_CONNECT_TIMEOUT_MS`                              | `5000`            | `amqp()`                                  |

  The drain timings are the reason this shape matters: they have to agree with
  the pod's `terminationGracePeriodSeconds`, which lives in the manifest — so
  they belong beside it rather than compiled into the image. The same is true of
  a CORS origin, a body limit and Temporal's shutdown budget.

  **Every variable carries its starter's prefix** — `HTTP_`, `TEMPORAL_`, `AMQP_`,
  `STORAGE_S3_` — because several starters share one process, and a bare
  `BODY_LIMIT` is a name the next starter would also want. The exceptions are
  names the ecosystem already owns and a platform injects (`PORT`, `HOST`,
  `DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `LOG_LEVEL`), plus the kernel's own
  three, since a process has exactly one kernel.

  `@btravstack/config` gains **`Config.boolean`** for the flags: `true`/`false`,
  `1`/`0`, `yes`/`no`, `on`/`off`, case-insensitive. Anything else is an error
  rather than a falsy reading — a deployment that wrote `HTTP_COMPRESSION=enabled`
  meant to turn it on.

  Three things stay composition-time on purpose: a **shape** (`plugins`, a CORS
  record's allowed headers), because an environment carries strings; a **graph
  decision** (`instrumented`), because it changes what is built; and
  `securityHeaders`, because a deployment that can silently turn
  `x-frame-options` off is a footgun the other policies are not.

  ## Consequences
  - `HttpConfig` is `{ port, hostname, bodyLimit, corsOrigin, compression }`,
    `TemporalConfig` gains `{ gracePeriodMs, forceAfterMs }`, and `AmqpConfig`
    gains `{ connectTimeoutMs }`. Anything in the graph may read them.
  - **`AMQP_CONNECT_TIMEOUT_MS` defaults to 5 s where the library defaults to
    30**: thirty seconds is longer than most orchestrators wait before
    restarting the pod, so an unreachable broker is now reported rather than sat
    on.
  - A malformed `PROBE_PORT`, `PRE_DRAIN_DELAY_MS` or `DRAIN_TIMEOUT_MS` is one
    `RuntimeStartFailed` with `runtime: "kernel"` (it was `"probes"`) whose
    `ConfigInvalid` names **every** variable that was wrong — one round trip for
    the operator. A probe _bind_ failure is still `runtime: "probes"`.
  - `HttpOptions`, `TemporalTuning` and `AmqpTuning` are each spelled once and
    intersected into the module sugar's options, which now forwards the whole
    record instead of field by field. An option the sugar forgets to forward can
    no longer exist — which is what this issue was about.

  ## `bodyLimit` defaults on, and the other two default off

  An unbounded body is a trust boundary, where CORS and compression are policy a
  framework guessing is worse than one staying quiet. Over the limit is oRPC's
  `PAYLOAD_TOO_LARGE`, decided on `content-length` when one is sent and while
  streaming otherwise. `bodyLimit: false` — or `BODY_LIMIT=0` — is the previous
  unbounded behaviour.

  `compression` is the **response** half. Request decompression stays a
  `plugins` line: inflating a body before the limit measures it is a decision an
  application should make in the open.

  **CSRF stays a `plugins` line, and the claim was narrowed to say so.**
  `packages/http-server/CLAUDE.md` stated CORS, body limits, compression, CSRF,
  security headers and authentication were all "handler configuration, not a
  middleware slot" while the code shipped that for two of the six. oRPC's CSRF
  protection only bites on a request carrying a `SameSite` cookie, and this
  package configures no cookies, so it becomes an option when they arrive.

### Patch Changes

- Updated dependencies [419a9d5]
  - @btravstack/config@0.7.0
  - @btravstack/contract@0.7.0
  - @btravstack/core@0.7.0
  - @btravstack/di@0.7.0

## 0.6.0

### Minor Changes

- d6c035a: Health checks: a module declares one, the kernel serves them at `/healthz`.

  ```json
  {
    "status": "unhealthy",
    "components": [
      { "name": "cache", "status": "healthy" },
      {
        "name": "database",
        "status": "unhealthy",
        "reason": "connection refused"
      }
    ]
  }
  ```

  `@btravstack/cache`, `@btravstack/storage` and `@btravstack/prisma` each
  contribute a check. An application composing them wires nothing: one unhealthy
  component makes the whole application unhealthy, and the report names every
  component rather than stopping at the first failure.

  **`Port.many`/`Provider.member` are back in `@btravstack/di`.** They were
  removed because an audit found no consumer — true then, and false as soon as a
  second feature wanted the shape. A set port is what lets a starter DECLARE a
  check rather than register one: a registry the kernel handed out would
  type-check whether or not the call was ever made, so a starter that forgot
  would compile and report healthy forever.

  A set port nobody contributed to now resolves to `[]` rather than throwing —
  the behaviour both di reference pages already documented, and which an
  application composing no starter hits immediately.

  **`/healthz` does not gate `/readyz`.** Readiness removes a pod from its
  Service's endpoints, so failing it on a dependency several replicas share takes
  every replica out at once and turns a degraded system into an outage. The
  kernel reports; an operator decides what a `503` there means.

  `@btravstack/mailer` contributes no check: its port offers only `send`, and a
  probe that delivers mail is not a probe. A cheap `verify()` belongs to the SMTP
  adapter, and can be added there without changing this shape.

  `PrismaLike` now requires `$queryRaw` — every generated Prisma client has it,
  and the check needs the server to answer something rather than trusting a
  pooled client's idea of "connected".

- b905a31: A starter offers its OpenTelemetry instrumentation; composing `otel()` registers it.

  `@btravstack/core` declares an `Instrumentations` set port. A package
  contributes a loader, `() => Promise<unknown>`; `@btravstack/observability/otel` loads every
  contribution and hands it to the `NodeSDK`. Composing a starter **declares**
  what can be instrumented, and composing `otel()` is what turns it on — the
  Spring Boot starter shape, in one port.

  `@btravstack/prisma` is the first contributor. Engine tracing used to be
  enabled while the client was built, whether or not an SDK existed; it is now
  offered, so a graph with no `otel()` never loads `@prisma/instrumentation` at
  all.

  **This does not weaken the preload rule.** `@opentelemetry/auto-instrumentations-node/register`
  still has to be preloaded before the libraries it patches are imported, and no
  provider can promise that. The rule was always about instrumentations that
  patch module loading — one whose `enable()` sets a helper the library reads per
  call has no such ordering requirement, and those are what `otel()` registers.

  `load` is async and answers `undefined` rather than failing, because the
  package supplying the instrumentation is an optional peer the consumer may not
  have installed. The contributor logs the skip, since it is the one that knows
  why.

  `otel()` contributes a member of its own that loads nothing — a collector
  depending on a set port nothing provides is an unmet dependency both at plan
  time and in `Needs`, and Guice's `newSetBinder` declares the empty set for the
  same reason.

  `Tracer` leaves `@btravstack/prisma`'s instrumented `needs`. It was there for
  ordering, to get the SDK up before the instrumentation was enabled; the SDK now
  does the registering, so the ordering is inherent. `Meter` still orders the
  client after `otel()`.

### Patch Changes

- Updated dependencies [d6c035a]
- Updated dependencies [1427b48]
- Updated dependencies [b905a31]
  - @btravstack/config@0.6.0
  - @btravstack/contract@0.6.0
  - @btravstack/core@0.6.0
  - @btravstack/di@0.6.0

## 0.5.0

### Minor Changes

- aec5a7a: Remove four pieces of public surface nobody uses.

  **`HasMark<C>` is gone** from `@btravstack/http-server`. It existed for exactly
  one hypothetical consumer — its own TSDoc said so: "exported for tooling over a
  contract — an OpenAPI generator deciding whether to emit `security` at all."
  That generator now exists, and it uses `isAuthenticated` instead, because
  emitting `security` needs the requirements rather than a boolean. Its only other
  references were two type tests asserting `HasMark` against itself.

  **`urlVar` is gone** from `prismaDatabase`. It was added so two databases in one
  application would not collide on `DATABASE_URL`; no application has a second
  database, no spec set it, and the collision it prevented has never happened.

  **The `client` arrow takes only the adapter now**, not `(adapter, url)`. The URL
  was passed for a client that wanted it directly; every documented sample takes
  `(adapter)`. The one place that read it was a spec asserting the URL reached the
  adapter — which now reads it **off the adapter**, a stronger assertion than the
  argument allowed, since it proves the thing that actually reaches Postgres was
  configured.

  **`BootDefaults` and `SubmittedUnit` are no longer exported** from
  `@btravstack/testing`. Both stayed internal types; neither had a consumer
  outside the package, and neither TSDoc named one — which is this repository's
  own bar for a library-facing export.

  Nothing here changes behaviour. Each was flexibility added ahead of a need that
  did not arrive, and three of the four were added within the last week.

- c118a74: Raise the published Node floor to `>=22`, and use `Promise.withResolvers`.

  Node 20 reached end of life on **2026-04-30**. Every line that still receives
  security fixes — 22, 24, 26 — satisfies `>=22`, so this drops a promise rather
  than a supported runtime.

  **The old floor was never provable.** CI runs the dev toolchain, and pnpm 11
  needs `node:sqlite`, which Node 20 does not have — so no job here could ever
  execute the line `>=20` named, and `ci.yml` said so in a comment. The new floor
  sits on the same major as the matrix's `22.22` row, so the promise is exercised.

  The knock-on is `@btravstack/core`'s: `createDeferred` was an eight-line shim
  for a primitive the platform ships as `Promise.withResolvers`, held back only
  by the floor. It is gone, along with `src/deferred.ts`. `Deferred` was never
  exported, so no public surface moves — the only visible change is the
  `engines` field.

  `packages/core` raises its `lib` to `ES2024` for this, alone in the repository
  and commented where it happens; the shared `@btravstack/tsconfig` base stays on
  `ES2023` until a second package needs otherwise.

- 6a36dde: Emit an OpenAPI document from a contract, with the security marker folded in.

  ```ts
  import { openApiDocument } from "@btravstack/http-server/openapi";

  const document = await openApiDocument(contract, {
    base: { info: { title: "Order API", version: "1.0.0" } },
    securitySchemes: { user: { type: "http", scheme: "bearer" } },
  });
  ```

  `@btravstack/contract` has modelled OpenAPI's security semantics exactly for a
  while — AND versus OR, scopes, nearest-mark-wins — and produced no document, so
  the model reached TypeScript and nothing else. This closes that: Swagger UI,
  client codegen for non-TypeScript consumers and API-gateway integration all
  consume a document, not a `.ts` file.

  **It is a fold, not a translation.** `Requirement` is
  `Readonly<Record<string, readonly string[]>>` — byte-identical to OpenAPI's
  `SecurityRequirementObject`, keys within one object AND, separate objects OR.
  The emitted `security` is the marker's own value, reinterpreted nowhere.

  A document from this stack carries **OR and never AND**, because AND cannot be
  expressed a layer earlier: `@btravstack/contract` refuses the multi-key
  requirement OpenAPI reads as AND, since this package would run it as OR.

  `securitySchemes` is yours to supply, because the contract deliberately says
  WHICH schemes protect a route and never what a scheme IS — the same split
  `defineHttp({ authenticators })` makes, one layer out.

  **Nothing serves it**, and that is a decision rather than an omission: a Swagger
  UI bundle inside a transport package would be a runtime dependency for every
  consumer, including those who never ask for a document. An application serves
  the value from a route of its own; `examples/order-api/src/openapi.ts` is the
  recipe, and its spec asserts the real document — including `/orders/export`,
  which carries OR across two schemes and a scope straight out of the application's
  own contract.

  `@orpc/openapi` and `@orpc/json-schema` are **optional peers behind the
  `/openapi` subpath**, so a consumer that never imports it installs neither.

### Patch Changes

- Updated dependencies [b921945]
- Updated dependencies [c118a74]
  - @btravstack/di@0.5.0
  - @btravstack/config@0.5.0
  - @btravstack/contract@0.5.0
  - @btravstack/core@0.5.0

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
