# @btravstack/testing

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
