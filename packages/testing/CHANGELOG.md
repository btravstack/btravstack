# @btravstack/testing

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
