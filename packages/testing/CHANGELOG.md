# @btravstack/testing

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

### Patch Changes

- Updated dependencies [b921945]
- Updated dependencies [c118a74]
  - @btravstack/di@0.5.0
  - @btravstack/config@0.5.0
  - @btravstack/core@0.5.0

## 0.4.0

### Patch Changes

- @btravstack/config@0.4.0
  - @btravstack/core@0.4.0
  - @btravstack/di@0.4.0

## 0.3.0

### Minor Changes

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

- 76f58c4: The last mute diagnostics speak. `Module.build`, `Module.scoped` and
  `Module.forkScope` gate unmet dependencies with `DependencyGate`, a marker
  intersected onto the `module` parameter, and `tapped` gates an unexported
  port with `TapGate` on its `ports` array — replacing the conditional rest
  tuples whose failure was a bare arity line (`Expected 3 arguments, but got
1.`) that named neither the label nor the port. The message now ends on what
  is missing: `required in type '{ readonly "UNSATISFIED DEPENDENCIES — nothing
provides": Cfg; }'`. Every gate a composing application meets is now the same
  marker mechanism, and every one prints a name. The phantom rest arguments are
  gone from the signatures; nothing could ever pass values for them.
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

- f615282: The testing half of "swapping an adapter is composing a different module".
  `@btravstack/testing`'s `overridden(module, overrides)` substitutes named
  providers into the real composition root — the seam composition cannot
  reach, since nothing can be layered over a graph that already provides a
  port. Its primitive is `@btravstack/di`'s one deliberately test-facing
  export, `overrideProvider`: at plan time the override replaces the base
  provider (which is never constructed), an override with nothing to override
  is a loud `WiringDefect` — the drift gate a hand-maintained parallel root
  never had — and two overrides for one port stay the duplicate defect.
  Production composition stays override-free by convention.
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
- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.
- Updated dependencies [4499df1]
- Updated dependencies [6f964fa]
- Updated dependencies [76f58c4]
- Updated dependencies [41aa1fb]
- Updated dependencies [fc38b9a]
- Updated dependencies [9af980d]
- Updated dependencies [ccdcc32]
- Updated dependencies [82579e8]
- Updated dependencies [f615282]
- Updated dependencies [b8fdee9]
- Updated dependencies [31f70f7]
- Updated dependencies [d5be140]
- Updated dependencies [3bf4036]
- Updated dependencies [74621a1]
  - @btravstack/di@0.3.0
  - @btravstack/config@0.3.0
  - @btravstack/core@0.3.0

## 0.2.0

### Minor Changes

- 4fa693c: The application kernel: `start` boots a `@btravstack/di` module into a running
  process with one runtime, drains in-flight work on SIGTERM, and closes the
  application scope on every path.

  - `start(module, options)` returns a `RunningApp` — `exited`
    (`AsyncResult<ExitReport, E | RuntimeStartFailed>`, the module's own error
    type passed through unwrapped), `stop`, `requestDrain`, `phase`, `ready`,
    `probePort` and `runtimeInfo`. It never throws and never calls
    `process.exit`. The runtime's
    declared `needs` are checked against the module's exports at compile time.
  - The `Runtime` / `RuntimeHost` / `RunUnit` / `Serving` contract, with unit
    tracking owned by the kernel: `Serving.drain(signal)` returns
    `AsyncResult<void, never>` and the kernel does the accounting into a
    `DrainReport`.
  - A channel for what a runtime **is**: `Serving.info` publishes arbitrary
    structured info about a serving runtime, and `RunningApp.runtimeInfo()` reads
    it back as an `AsyncResult<Info | undefined, never>` that settles when the
    runtime starts serving — so a runtime binding an ephemeral `port: 0` tells the
    caller which port it got instead of inventing an `onListening` hook. The shape
    is the runtime's own (a queue runtime has no port), and `Info` defaults to
    `never`, so publishing is optional with no extra ceremony.
  - A three-beat drain — readiness false, `preDrainDelayMs` before the runtime
    stops accepting, then `drainTimeoutMs` for in-flight work — plus liveness and
    readiness probes served from the lifecycle state machine rather than a
    transport.
  - `runMain`, which turns an outcome into a process exit code (`0` / `1` / `2` /
    `70`) by setting `process.exitCode`.
  - `currentUnit()` over an `AsyncLocalStorage` record carrying
    `{ unitId, traceId, tenantId, deadline, signal }` — data, never capabilities.
  - A `@btravstack/testing` package with `testRuntime`,
    `createFakeClock` and `withApp`.
  - **Every async API returns an `AsyncResult`, never a bare `Promise`** — the
    infallible ones included, where `AsyncResult<T, never>` spells "async, and
    cannot fail". `probePort()`, `Clock.sleep`, `FakeClock.advance`,
    `UnitRegistry.awaitIdle`, `TestRuntime.untilStarted` and `ProbeServer.close`
    all carry `E = never`. Three surfaces are deliberately outside it: `runMain`
    (the boundary out of the Result world, into a process exit code), `UnitWork`'s
    `Promise<Result<T, E>>` arm (it accepts a caller's `async` handler) and
    `withApp`/`use` (a thrown assertion inside a test body must reach the test
    runner, which an `AsyncResult` — which never rejects — would swallow).

- b56501f: Remove `Port.many` and `Provider.member` from `@btravstack/di`, and `withApp`
  from `@btravstack/testing`.

  Set ports had no consumer: not one of the eight packages or ten example
  workspaces declared one. The exemption they needed had rippled into the
  container's levelling pass, which kept two count maps and a provider-identity
  `Set` so a set port's later members were not dropped once the first landed;
  readiness is now one membership test. Gone with them: the `MANY` brand,
  `ManyPortClass`, `MemberOf`, and the "registered as both a set port and an
  ordinary port" wiring defect.

  `withApp` was the callback harness that predated `bootFixture`, which does the
  same job — start, stop on every exit path, rethrow a shutdown `Defect` — inside
  the `test.extend` protocol the Test conventions mandate. Every example and
  every starter already used `bootFixture`; only the kernel's own four invariant
  specs still called `withApp`, and they now take the `boot` fixture.

- 5a271c0: **Breaking.** The runtime is a service the module provides, not an option.
  `StartOptions.runtime` is gone: `start(module, options?)`, `runMain(module,
options?, exit?)` and `withApp(module, options, use)` build the module,
  resolve its runtime through the kernel's new **`RuntimePort`** — `Port("Runtime")`,
  exported generic so a runtime package (or an application) declares its own
  concrete port over it, `class HttpRuntime extends
RuntimePort<Runtime<never, HttpInfo>> {}` — and drive what they find. The kernel is DI
  initialisation and lifecycle, nothing else; every runtime port shares one id,
  which is how a graph holds exactly one.

  The phantom gate grows a third arm: `NO RUNTIME` when the module exports no
  runtime port, alongside `UNSATISFIED RUNTIME NEEDS` and `UNSATISFIED UNIT
NEEDS`. `Needs` and `Info` are read off the module (`RuntimeInfoOf<X>` is exported), so
  `RunningApp<E, RuntimeInfoOf<X>>` types `runtimeInfo()` from the composition
  alone.

  `@btravstack/testing`: `testRuntime()` carries `.module`, a module
  providing itself on the exported `TestRuntimePort` — import it next to the
  module under test and export the port.

- 72b8fbd: **`@btravstack/testing`** — the test harness is a package of its own, the
  way `@nestjs/testing` is, and `@btravstack/core/testing` is gone (breaking,
  unreleased). It ships what the kernel's entry point did — `testRuntime()` /
  `TestRuntimePort`, `createFakeClock()`, `withApp()` — plus two things the
  example suites had been hand-rolling in every `test-fixtures.ts`:

  - **`bootFixture(defaults?)`** — a `test.extend` fixture handing the test a
    `boot(module, options?)` with a test's defaults baked in (`signals: false`
    always, `probes: false` unless a call asks for a port, `preDrainDelayMs: 0`,
    a silent `onEvent`), every application it started stopped when the test
    ends. Teardown mirrors `withApp`: a `Defect` on `exited` fails the test, a
    modeled `Err` passes through.
  - **`tapped(module, [Port, …])`** — read services out of a booted application
    (`start` hands the context to the runtime alone). Returns `{ module,
services() }`; the gate refuses a port `module` does not export, and
    `services()` is loud before the graph is built.

  The kernel's own specs, the three starters' and the three deployment
  examples' fixtures now use it; core keeps no test double of its own.

- e950473: `StartOptions.unit` — a module the kernel forks around **every unit**. Its
  providers are constructed as a unit opens, reading anything the application
  context carries, and torn down as it closes — while the unit's ambient record
  is still open, so a teardown log line carries the request's own trace id. Unit
  work receives the forked `Context`, which makes a per-request scope
  transparent: a handler routes, and no application code calls
  `Module.forkScope`.

  `start`'s compile-time gate also covers the fork's own direction: the unit
  module's needs must be met by the application module's exports (or `Scope`,
  or `Env`). A runtime's `needs` are checked against the application module's
  exports alone — a unit-only port is rejected at the call site, since
  `RuntimeHost.ctx` never carries it (see below). The unit
  module's error channel is pinned to `never` — a construction failure at unit
  scope has no modeled channel to land in, so it rides the unit's defect path,
  which every runtime already answers.

  A unit finaliser that fails is emitted as a `teardownError` event and kept off
  `ExitReport.teardownErrors`, which is the application scope's.

  Two things a runtime author should know. `RuntimeHost.ctx` remains the
  application context: a unit-provided port exists only while a unit is open,
  which is why the gate refuses a runtime that names one. And with a unit module the unit's
  work runs only once the fork is built — after an `await` when a provider is
  async — so a runtime subscribing to an event from inside its work must check
  whether it already fired. Without the option, unit work receives the
  application context exactly as before, synchronously. This closes the "Per-unit
  ports" deferral: `RunUnit` was typed for this fork from the start.

  `@btravstack/testing`'s `SubmittedUnit.signal` is now available
  synchronously after `submit()` whether or not a unit module is in play.

### Patch Changes

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
