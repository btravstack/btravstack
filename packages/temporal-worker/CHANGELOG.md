# @btravstack/temporal-worker

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

- e2afba6: Compose a worker's handlers and activities from one provider per contract key.

  `AmqpHandler(contract, key)` and `TemporalWorkflowActivities(contract, key)` each
  mint a port from the contract key and return di's own `Provider(port)`, so a slice
  owns its piece and declares only the services that piece calls.
  `AmqpHandlers(contract)([…])` and `TemporalActivities(contract)([…])` compose them:
  every declared key must be covered, and two slices claiming one key are di's
  duplicate-provider defect at build. Both starters' existing call forms are unchanged.

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
- ccdcc32: `releasedBy` is runtime-author toolkit now, exported from `@btravstack/core`.

  It was duplicated verbatim in `@btravstack/temporal-worker` and
  `@btravstack/amqp-worker` — identical bodies, divergent TSDoc — and any runtime
  whose `Serving.drain` awaits work settling on somebody else's clock needs it.
  Two copies was the last cheap moment to hoist.

  ```ts
  drain: (signal) => releasedBy(signal, running);
  ```

  `running`, but no later than the kernel's drain deadline. Without it,
  `Serving.stop` can outlive `drainTimeoutMs` by however long that other clock
  takes — Temporal's `shutdownForceTime`, a broker library's `close()`. The
  losing branch's `Result` is **dropped**, which is the point: once the deadline
  wins the kernel has moved on and nothing consumes the outcome. What that costs
  is the runtime's own business — an un-acked AMQP delivery is redelivered, so
  abandoning one repeats work rather than losing it, while a Temporal activity is
  retried on another worker.

  `whenAborted` stays private to `@btravstack/core`. `releasedBy` is the whole
  use case, and an unqualified "wait for this signal" invites the confusion
  below. Its already-aborted arm is load-bearing: `addEventListener` on an
  aborted signal never fires, so without it the race would hang.

  **`releasedBy` and `Clock.sleep` are not one primitive**, which the issue left
  open. `releasedBy` races work against a **signal** — no duration in it at all,
  so it is `Clock`-agnostic and behaves identically under
  `@btravstack/testing`'s fake clock. The kernel's own drain races work against
  `clock.sleep`, a **duration** on an injected clock the harness controls. They
  look alike; folding them together would drag a clock into a place that has no
  time in it.

- 758c539: Each runtime README carries an `## Options` index: one line per option —
  `connectionOptions`, `defaultConsumerOptions` and `connectTimeoutMs` were
  documented nowhere an npm consumer could see — with the reference page as
  the one detailed home for defaults and reasoning.
- 31f70f7: The repository is `btravstack/btravstack`, so every package's `homepage`,
  `bugs.url` and `repository.url` points there. GitHub redirects the old slug, so
  nothing was broken — but published metadata that names a repository should name
  the one it lives in.
- 5cfc023: The two suites that needed a server now share one with the rest of the
  repository instead of starting their own.

  `@btravstack/amqp-worker` boots against **one RabbitMQ container for the whole gate**
  rather than one per vitest run, and `@btravstack/temporal-worker` against **one
  Temporal server** with a namespace per spec file, in place of a time-skipping
  test server started per vitest worker. Neither suite ever advanced a clock, so
  the skippable clock bought nothing a private namespace does not — and
  `@btravstack/temporal-worker` no longer downloads a 64 MB binary on a cold cache.

  No public surface changes. This is what closed `pnpm test` being
  intermittently red at turbo's default concurrency, where five servers for six
  workspaces made the 60s testcontainers startup wait the first thing to give
  out.

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

- f9d48ec: **`@btravstack/temporal-worker` becomes a starter, and everything is a provider.**
  `temporal({ contract, workflows, address?, namespace?, gracePeriod?,
forceAfter? })` is a module providing `TemporalRuntime` (a `Runtime<never,
TemporalInfo>` on the package's own port over `RuntimePort`), `TemporalConfig`
  (`{ address, namespace }`, bound from `TEMPORAL_ADDRESS` / `TEMPORAL_NAMESPACE`
  unless pinned — explicit beats environment beats default, per field, through
  `Config.pinned`; a pinned field reads nothing from the environment, and the
  declared `Env` need and `ConfigInvalid` stay whatever is pinned) and
  `TemporalConnection` (the `NativeConnection`
  as a resource of the graph, opened with the scope and closed on every exit
  path; a service that will not answer is the modeled `TemporalUnreachable`).
  Import it next to the application, export `TemporalRuntime`, and provide the
  activities on the starter's own activities port.

  **Breaking.** `temporalRuntime`, `activityUnits`, `ActivityMiddleware`,
  `ActivityUnitContext` and `TemporalOptions.needs` / `connection` / `taskQueue`
  / `activities(host)` are gone. The activities are now provided on the
  **starter's own port** — one id, `Port("TemporalActivities")`, framework-owned
  like `TemporalConfig`, since a worker serves one activities record as it
  polls one task queue; typed per contract at the type level, so a provider
  built for one contract cannot be handed to a module declaring another — its
  service the implementations record `declareActivitiesHandler` takes for
  `contract`, with no injected context, built by a provider closing over the
  application's own services. That port is a need of the starter's module: the
  runtime resolves nothing from a `ctx`, `needs` is `never`, and a composition
  root that provides no activities is rejected by `start` for still owing the
  port. The starter calls `declareActivitiesHandler` itself, inside its error
  qualifier, with its unit middleware in place; the middleware injects nothing.
  `@temporal-contract/worker`, `@temporal-contract/contract` and
  `@btravstack/config` join the peer dependencies.

  **`TemporalModule(name)({...})` is the way an application writes its worker
  root.** `TemporalModule(name)({ contract, activities, workflows, address?,
namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports? })` is
  `Module(name)({...})` for a Temporal worker: `activities` is the **provider**
  on the starter's activities port for `contract` (what `TemporalActivities`
  returns; one built for another contract is refused), and the sugar imports the starter,
  provides the activities and exports `TemporalRuntime` — handing the augmented
  lists to di's own `Module(name)({...})`, whose return type is the sugar's, so
  `start`'s gate and di's see nothing new. `temporal()` stays exported as the primitive
  it delegates to. `TemporalModuleOptions` is exported for the type.

  **`TemporalActivities(contract)` is the activities provider builder.** The
  one call fixes the contract and hands back di's own `Provider(port)` on the
  starter's activities port typed for it — `(deps, arm)` with the usual typing,
  returning a provider that carries the port typed as `provider.port` (di's
  `PortClassOf<"TemporalActivities", ActivitiesOf<C>>`). There is no name to
  give and no hand-declared `class extends Port(name)<…>` line. A hand-written
  `Provider(port)` over the same port still works.

- 2f1974e: The Temporal worker runtime for `@btravstack/core`.

  `temporalRuntime({ connection, taskQueue, workflows, activities, needs })` runs a
  Temporal worker under the kernel's lifecycle: one unit per activity attempt, and
  a drain that releases the kernel at its **own** deadline rather than Temporal's
  `shutdownForceTime` — `@temporalio/worker` exposes no public forced shutdown, so
  stopping the wait is the only escalation available, and the worker keeps winding
  down underneath until the process exits.

  It integrates through `temporal-contract`: add `activityUnits(host)` to
  `declareActivitiesHandler`'s middleware and every activity attempt becomes a
  kernel unit with the application context injected. `temporal-contract` is not a
  peer dependency — the middleware type is structural — and `Result` → activity
  failure is deliberately not mapped here, because `declareActivitiesHandler`
  already does it.

### Patch Changes

- 068399d: **`UnitRecord` gains `signal: AbortSignal`** — the ambient record is five
  fields now, not four. It is the **very** controller the unit's work callback is
  handed, not a copy: one abort, two ways to reach it, fired at the drain
  deadline or at once on a path that skips the drain.

  The gap it closes: a middleware-shaped runtime opens its unit around a call it
  does not own the arguments of. `@btravstack/temporal-worker`'s `activityUnits` and
  `@btravstack/amqp-worker`'s `messageUnits` both hand the kernel a work callback that
  _is_ the library's `next()`, so an activity or a handler had no parameter to
  receive the signal through and the kernel's `drainTimeoutMs` was unobservable
  from inside the work. Injecting a context the transport's contract does not
  type was the alternative, and it is exactly the hidden-dependency shape `di`
  exists to prevent, so the signal travels on the record instead — data about
  this unit, like `deadline`, with nothing to substitute in a test.
  `@btravstack/http-server` is unchanged: it still passes the same signal as its
  handler's third parameter.

  What each transport does with it is the transport's own business, and both
  examples are worked:

  - **`examples/order-amqp-worker`** answers a `RetryableError` when
    `currentUnit()?.signal.aborted`, leaving the delivery un-acked so the broker
    hands it to the next worker. This transport has no cancellation of its own —
    a redelivery is recovery, not cancellation.
  - **`examples/order-temporal-worker`**'s `ShippingService.arrange` fails as a
    **defect**, which the platform retries on another worker. The contract's
    `ShippingUnavailable` is a permanent no and would be the wrong error for "we
    ran out of time". Temporal's `Context.current().cancellationSignal` is a
    different clock — workflow-side cancellation, and worker shutdown after
    `shutdownGraceTime` — so the two are honoured together rather than one
    standing in for the other.

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
