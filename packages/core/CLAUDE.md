# packages/core

The kernel's public surface and its internals. The root `CLAUDE.md` carries
the thesis and the conventions, and nothing else states this package's API —
that copy lived there until it drifted. All three sections below are
load-bearing: keep them in sync with the code in the same commit.

The specs import `@btravstack/testing` (`testRuntime`, `createFakeClock`,
`bootFixture`), which peers on this package and is therefore **not** a
devDependency here — `tsconfig.json`'s `paths` (the built d.ts, ordered by
`turbo.json`'s `@btravstack/core#typecheck` edge), `vitest.config.ts`'s
aliases and `knip.json` carry it instead, and `tsconfig.build.json` is what
`tsdown` compiles so the published `dist` never sees it. The arrangement and
its reason are spelled out under _Toolchain & conventions_ in the root
`CLAUDE.md`. `test-fixtures.ts`'s `runtimeModule(runtime)` wraps a hand-built
runtime the way `TestRuntime.module` wraps the plain one.

## Public surface

`packages/core/src/index.ts` is the one place the kernel's API is decided —
one entry point.

- **`start(module, options?)` → `RunningApp<E, RuntimeInfoOf<X>>`** — the
  entry point. Takes a `Module<X, E, Scope | Env>` (not `Module<X, E,
never>`: `Needs` is covariant on `Module`, so this accepts a needs-free
  module, the resourceful one whose `acquire`/`release` provider adds `Scope`
  — the single need `Module.scoped` discharges itself — and one whose
  configuration reads `Env`, which the kernel wraps in as it builds; a module
  that provides `Env` itself is wrapped without it, and its own wins).
  **The runtime is a
  service of that module**, not an option: the module exports a port declared
  over `RuntimePort`, the kernel builds the graph, resolves that port and
  drives what it finds. The kernel is DI initialisation and lifecycle, nothing
  else. The `module` parameter is intersected with the phantom marker
  `StartGate<X, UnitNeeds>`: `NO RUNTIME` when the module exports no runtime
  port, `UNSATISFIED RUNTIME PORTS` when what the runtime resolves is not
  among the module's exports (the module's alone — a unit-only port exists only
  while a unit is open, and `RuntimeHost.ctx` is the application context),
  `UNSATISFIED UNIT NEEDS` for the fork's own direction — all three at the
  call site, as an assignability failure that **prints the arm's sentence**.
  `unknown` is the satisfied arm, and it has to be: intersecting `unknown`
  leaves the module type untouched, so a good call infers exactly as it
  would without the marker.
- **`RuntimePort`** — `Port("Runtime")`, exported **generic** (no fixed
  service): a runtime package declares its own concrete port over it —
  `class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}`
  — so every runtime is one id at runtime while each carries its own
  `Resolves`/`Info` in the type. `RuntimeOf<X>` / `RuntimeResolvesOf<X>` /
  `RuntimeInfoOf<X>` read those back out of a module's exports (only
  `RuntimeInfoOf` is exported — the other two are the gate's internals);
  `RuntimeInstance` is the shared instance type
  (`InstanceType<PortClass<"Runtime">>`, internal too). Every
  runtime package ships its port and a starter — `HttpRuntime`/`http()`,
  `TemporalRuntime`/`temporal()`, `AmqpRuntime`/`amqp()` — and none of them
  has a `resolves` any more: each takes the application's router / activities /
  handlers as a **port its runtime provider depends on** through di — the
  starter's own fixed port (`HttpRouterPort`, `TemporalActivitiesPort`,
  `AmqpHandlersPort`, one id each; the temporal and amqp ones typed per
  contract at the type level, the same generic-value move `RuntimePort`
  itself makes), which the application provides and never names — so their
  `Resolves` is `never` and `RuntimeHost.ctx` goes unread by every shipped
  runtime. The kernel keeps `Runtime.resolves`, `RunUnit`'s typed `ctx` and the
  `UNSATISFIED RUNTIME PORTS` arm as the general contract (`testRuntime` and a
  hand-rolled runtime still use it), but no starter does. A port's service
  type is fixed at declaration, which is why a runtime with application-specific
  needs could not ship its port — the reason the needs went, not a constraint
  to work around.
- **`StartOptions<UnitX, UnitNeeds>`** — `env` (the environment the graph is
  configured from, provided to it as `@btravstack/config`'s `Env` port and
  what the kernel reads its own `PROBE_PORT` from; default `process.env`, a
  test hands in a record);
  `unit` (a `Module<UnitX, never, UnitNeeds>` the kernel forks around **every
  unit**: built as the unit opens, torn down as it closes — while the unit's
  ambient record is still open — reading anything the application context
  carries; this is what makes a per-request scope transparent, so no handler
  ever calls `Module.forkScope` itself. Its error channel is pinned to `never`
  — a construction failure at unit scope has no modeled channel and rides the
  unit's defect path, which every runtime already answers — `@btravstack/http`
  writes the `500` from its `recoverDefect`, precisely because that failure
  happens before the handler is reached. A unit finaliser that fails is
  emitted as a `teardownError` event only, never pushed into
  `ExitReport.teardownErrors` (which is the application scope's, and would
  grow unbounded). With the option, unit work runs only once the fork is
  built — after an `await` when a unit provider is async — so a runtime that
  subscribes to an event from inside its work must check it has not already
  fired (see contract 3 above). The gate checks
  both directions at the call site: runtime `resolves` may draw on `UnitX`, and
  `UnitNeeds` must be covered by the module's exports or `Scope`. One caveat:
  `RuntimeHost.ctx` is the **application** context, so a unit-provided port
  exists only inside unit work — resolving one at runtime startup is a
  defect); `clock`
  (default `systemClock`); `signals` (default `true`; **`false` disables the
  SIGTERM/SIGINT handlers _and_ the uncaught ones together**); `probes`
  (`{ port }` or `false`; unset, bound from `PROBE_PORT` in `env`, default
  `9000` — the one piece of configuration the kernel binds itself, because
  the probe server is up before the graph exists; a bad value is a
  `RuntimeStartFailed` for `"probes"` whose `cause` is the `ConfigInvalid`,
  which is what `runMain` reads the `78` off); `preDrainDelayMs` (`5_000`);
  `drainTimeoutMs` (`20_000`); `onEvent` (default `stderrSink`).
- **`RunningApp<E, Info>`** — `exited` (`AsyncResult<ExitReport, E | RuntimeStartFailed>`),
  `stop()`, `requestDrain()`, `phase()`, `ready()`, `probePort()`,
  `runtimeInfo()`.
  `stop()` exits without draining; `requestDrain()` takes the signal path.
  `ready()` is the synchronous read of the same predicate `/readyz` answers
  from — needed because the uncaught path forces it false while the phase is
  still `"serving"`, a window no HTTP round trip fits inside; it is also what an
  embedder wires into a health endpoint of its own when `probes: false`.
  `probePort()` is an `AsyncResult<number | undefined, never>` resolving the
  port actually bound (the point of it is `{ port: 0 }`), or `undefined` when
  probes are disabled or the bind failed. `runtimeInfo()` is the same deferred
  one layer up, for the **runtime**: an `AsyncResult<Info | undefined, never>`
  resolving whatever the runtime published on `Serving.info` once it is serving,
  and `undefined` when it publishes nothing or never got there.
- **`ExitReport`** — `reason` (`"signal" | "runtimeStopped" | "uncaught"`),
  `drain` (`DrainReport | undefined` — `undefined` whenever the drain was
  skipped), `teardownErrors`, `uptimeMs`. **`TeardownError`** is
  `{ port, cause }`.
- **`DrainReport`** — `inFlightAtStart` (units in flight when the drain began),
  `completed` (units that **closed during** the drain — it may exceed
  `inFlightAtStart` if in-flight work spawned more, which is honest reporting,
  not a bug), `abandoned` (units still open at the deadline; **the field the
  exit code keys on**).
- **`Runtime<Resolves, Info>` / `RuntimeHost<Resolves>` / `RunUnit<Resolves>` /
  `Serving<Info>`** — the runtime contract (the _service_ behind a runtime
  port). All parameterised by port **classes**
  (`Resolves extends AnyPort`) but handing out `Context<InstanceType<Resolves>>`,
  because di parameterises `Context<in R>` by port **instance** types.
  `Serving.drain(signal)` returns `AsyncResult<void, never>` — **not** a
  `DrainReport`: only the kernel can see the unit registry, so the kernel owns
  the accounting. `drain` means "stop accepting"; the `AbortSignal` fires when
  the kernel's deadline passes, so a runtime never does arithmetic on time.
  `Serving.info?: Info` is what the runtime publishes about **itself** once it
  is serving, read back through `RunningApp.runtimeInfo()`. `Info` is the
  runtime's own shape and deliberately **not** a port number — an ephemeral
  `port: 0` bind is the motivating case, but a queue consumer has none and
  would publish `{ queue, prefetch }`. It defaults to `never`, so `info` is
  unwritable and both types read exactly as they did for a runtime with nothing
  to publish; that default is what makes publishing optional with no ceremony.
- **`RuntimeStartFailed`** — the one error the kernel mints, a `TaggedError`
  carrying `{ runtime, cause }`. A probe bind failure uses
  `runtime: "probes"`.
- **`UnitMeta` / `UnitWork` / `UnitRegistry`** — `UnitMeta` is
  `{ kind, id, traceId?, tenantId?, deadline? }`; `traceId` defaults to `id`,
  which is why **`id` must be unique per unit** unless the runtime supplies one
  (see _Two contracts a runtime owes_ above).
  `UnitWork` may return an `AsyncResult`, a `Promise<Result>` or a plain
  `Result` — the `Promise` arm is Thesis #6's second exception, since it exists
  to accept a caller's `async` handler. `UnitRegistry.awaitIdle()` returns
  `AsyncResult<void, never>`.
- **`UnitRecord`** — the ambient record: `{ unitId, traceId, tenantId, deadline,
signal }`. `signal` is the same `AbortSignal` `UnitWork` receives as its
  argument — aborted at the drain deadline, or at once on a path that skips the
  drain (`abortAll`) — carried here so a runtime whose work callback is a
  library's `next()` still reaches it. Guarded by `units.spec.ts` → _"carries
  the work's own AbortSignal on the ambient record"_.
- **`currentUnit()` → `UnitRecord | undefined`** — the ambient read. `undefined`
  outside a unit.
- **`Clock` / `systemClock`** — `{ now, sleep(ms, signal?) }`, where `sleep`
  returns `AsyncResult<void, never>`. It takes an `AbortSignal` because a second
  signal must cut the pre-drain delay short, and `systemClock` `unref`s its
  timer so a shutdown sleep is never the reason the event loop stays alive.
- **`Phase`** — `"building" | "starting" | "serving" | "draining" | "stopping" | "exited"`.
- **`KernelEvent` / `EventSink` / `stderrSink`** — nine events: `building`,
  `startFailed`, `serving`, `draining`, `drained`, `stopping`, `exited`,
  `teardownError`, `uncaught`. `startFailed` carries the `cause` of any
  startup failure — a modeled `Err` (a `ConfigInvalid` naming its variables,
  a `RuntimeStartFailed`) or a defect — and is emitted before `stopping`, so a
  process that never came up says why on stderr instead of exiting silently.
  `stderrSink` writes one JSON line per event, normalising an
  `Error` cause to `{ name, message, stack, cause }` — `JSON.stringify` skips
  non-enumerable properties, so a bare one renders the two cause-carrying
  events as `{"cause":{}}`. A cause it cannot serialise at all (a circular
  object) falls back to `"[unserialisable]"` rather than throwing, since
  `safeSink` would swallow the throw and the event would be reported nowhere.
- **`runMain(module, options?, exit?)`** — the front door: `start` composed
  with the wait for `exited`, carrying the same phantom needs gate
  (`StartGate`, the shared alias all three gated surfaces use). Every
  `main.ts` calls this one function; `start` is for callers that want the
  `RunningApp` itself. It boots the module and sets the exit code:
  `0` clean, `1` a modeled startup `Err`, `78` a `ConfigInvalid` (or a
  `RuntimeStartFailed` carrying one — the kernel's own `PROBE_PORT`), `2`
  drained with work abandoned **or exited with a non-empty
  `teardownErrors`**, `70` an uncaught exception/rejection, `70` a defect.
  Both `70`s are sysexits(3)'s `EX_SOFTWARE`; `78` is its `EX_CONFIG` — the
  deployment is wrong, not the code, the one startup failure fixed without a
  rebuild. **A crash outranks abandoned work** — written out explicitly
  rather than left to depend on the fact that the uncaught path skips the drain
  anyway. `2` means "we stopped, but not cleanly", and a failed finaliser earns
  it as much as abandoned work does: the kernel goes to real trouble to keep
  those errors observable (the `teardownErrors` aliasing), which reporting `0`
  over them would waste.

There is **no** `Defect` construction, no `overrideProvider`, no accumulation of
runtimes, and no `recoverFailure`-style channel-moving helper. Swapping an
adapter is composing a different module, which di already documents and the type
checker already verifies.

## Load-bearing runtime invariants (tests must guard these)

The nine from the design, each with the test that guards it, plus the ones that
came out of implementation. `invariants.spec.ts` carries the numbered nine 1:1
(the ones proved elsewhere are recorded there as comments pointing at the test
that proves them, rather than duplicated).

1. **Readiness goes false before the runtime stops accepting.**
   `invariants.spec.ts` → _"the drain flips readiness false before the runtime
   stops accepting"_ (end-to-end through the real `/readyz` endpoint — the
   ordering only means something if an orchestrator would see it), and
   `drain.spec.ts` → _"flips readiness false, waits preDrainDelayMs, then tells
   the runtime to stop accepting — in that order"_ (the same ordering inside
   `drainApp`).
2. **In-flight units complete when the drain has time for them.**
   `invariants.spec.ts` → _"2. in-flight units complete when the drain has time
   for them"_.
3. **Units still open at the deadline are counted as abandoned.**
   `invariants.spec.ts` → _"3. units still open at the deadline are counted as
   abandoned"_; the accounting itself in `drain.spec.ts` → _"counts a unit still
   open at the deadline as abandoned"_.
4. **The unit `AbortSignal` fires at the drain deadline.**
   `invariants.spec.ts` → _"4. the unit AbortSignal fires at the drain
   deadline"_. The abort comes from `registry.abortAll()`, not from the runtime
   honouring `Serving.drain(signal)` — `@btravstack/testing`'s `testRuntime`
   deliberately ignores that signal, which is what makes it a test of the
   kernel. **The same signal is on the ambient record**, so a runtime whose
   work callback is a library's `next()` still reaches it:
   `units.spec.ts` → _"carries the work's own AbortSignal on the ambient
   record"_ asserts identity (`record.signal === the parameter`) and the abort
   together, and `@btravstack/temporal`'s and `@btravstack/amqp`'s own
   _"hands the activity/handler the unit's own AbortSignal, through the ambient
   record"_ prove it end to end through a real transport.
5. **The application scope closes on every path.**
   `invariants.spec.ts` → _"5. the application scope closes on a startup
   failure"_; `start.spec.ts` → _"closes the application scope on a clean
   stop"_.
6. **A second signal skips the drain.**
   `start.spec.ts` → _"drains on SIGTERM and skips the drain on a second
   signal"_ (real handlers, and it asserts the exit does not wait out the
   timeouts).
7. **Teardown errors are collected and never mask the exit reason.**
   `invariants.spec.ts` → _"7. teardown errors are collected without masking the
   exit reason"_; `start.spec.ts` → _"surfaces a failing release in the exit
   report's teardown errors"_.
8. **`start` never throws and never calls `process.exit`.**
   `invariants.spec.ts` → _"8. start neither throws nor calls process.exit"_;
   `run-main.spec.ts` → _"never calls process.exit"_.
9. **Signal listeners are removed on exit, so a second `start` in the same
   process is clean.** `start.spec.ts` → _"drains on SIGTERM and skips the drain
   on a second signal"_ (SIGTERM/SIGINT back to baseline) and _"skips the drain
   and marks itself unready on an uncaught exception"_
   (uncaughtException/unhandledRejection). The third route — a probe **bind
   failure**, which neither reaches — is `invariants.spec.ts` → _"a bind failure
   stops the graph being built and still disposes the handlers"_, which asserts
   the rise as well as the fall (a `start` that never installed a handler would
   satisfy "back to baseline" on its own).

Beyond the nine:

- **Readiness is a one-way latch.** Forced false by the drain and by an uncaught
  exception, never reset. `invariants.spec.ts` → _"readiness never returns to
  200 once forced false"_. The `forcedUnready` term of `ready()` is load-bearing
  on **exactly one** path — see Internal design — and is guarded solely by _"an
  uncaught exception forces readiness false while the phase is still serving"_.
- **The exit code for `"uncaught"` outranks abandoned work.**
  `run-main.spec.ts` → _"lets an uncaught reason outrank abandoned work"_ and
  _"exits 70 when an uncaught exception stopped the application"_.
- **`DrainReport.completed` can never go negative.** It is a delta of a
  monotonic counter, not `inFlightAtStart - abandoned`. `drain.spec.ts` → _"does
  not let a unit that starts after inFlightAtStart is sampled drive completed
  negative"_.
- **The drain cannot deadlock past its deadline on a compliant runtime.** The
  timeout races the runtime having stopped _and_ the registry going idle; it is
  never awaited on its own. `drain.spec.ts` → _"cuts the current wait short when
  skip is aborted mid-drain"_ and _"resolves both sleeps immediately when skip
  is already aborted"_.
- **A unit is counted closed on every exit path, including a throw.**
  `units.spec.ts` → _"decrements even when the work throws"_.
- **The ambient record does not leak between concurrent units.**
  `units.spec.ts` → _"does not leak between concurrent units"_.
- **The record's `signal` IS the work's own, not a copy.** One
  `AbortController` per unit: `registry.run` hands `controller.signal` to
  `work` and puts that same object on the `UnitRecord`, so `abortAll` — and
  therefore `drainApp`'s deadline — is observable from both routes at once. A
  second controller mirrored onto the record would drift on exactly the path
  that matters. `units.spec.ts` → _"carries the work's own AbortSignal on the
  ambient record"_.
- **The phase tracker is monotonic.** `phase.spec.ts` → _"refuses to move
  backwards and reports nothing"_ and _"treats re-entering the same phase as a
  no-op"_.
- **A throwing event sink cannot take the process down mid-shutdown.**
  `events.spec.ts` → _"swallows a throwing sink"_. `safeSink` is what
  guarantees it, and it stays load-bearing even though the sink most
  applications now pass — `@btravstack/observability`'s `kernelEvents(logger)`
  — cannot throw on its own account, since `createLogger` swallows a broken
  destination for the same reason one layer down. The kernel takes no logger
  dependency and must not grow one: `onEvent` is the seam, and that package
  is a consumer of it like any other.
- **A construction failure keeps the module's own error type.** `start.spec.ts`
  → _"reports a construction failure without wrapping the module's own error"_.
- **`probePort()` can never hang.** The deferred is settled on every route out
  of the bind attempt — bound, disabled, failed. `invariants.spec.ts` → _"a bind
  failure stops the graph being built and still disposes the handlers"_ asserts
  the failure route resolves `undefined`; every `probes: { port: 0 }` test
  asserts the success route.
- **The probe socket is closed at both dispose sites.** `invariants.spec.ts` →
  _"both dispose sites close the probe socket"_.
- **No `Result` is produced and left unexamined — with exactly two audited
  exceptions, each carrying its reason inline.** `AsyncResult<T, never>` empties
  the **error** channel only; a `Defect` can still be there, and a `Serving`
  written by a third party is where one comes from. `drain.spec.ts`'s four
  _"propagates a Defect from …"_ tests guard the drain;
  `packages/testing/src/boot-fixture.spec.ts` → _"fails the test on a shutdown
  defect, and only on a defect"_ the fixture. The two
  survivors are `start.ts`'s `void server.close()` (our own `fromSafePromise`
  over `server.close(cb)`, so no third-party code can defect inside it — and it
  must not be awaited: the socket is `unref`'d and `close` waits out live
  keep-alive connections, which would delay or strand the exit report) and
  `drain.ts`'s losing race branch (once the timeout has decided the report,
  `exited` has settled and a late defect has no consumer left). Neither can
  float: an `AsyncResult` never rejects. `unthrown/no-unhandled-result` cannot
  catch this class — it is deliberately syntactic, and an `await` inside a
  larger expression is not a bare expression statement — so review is the only
  guard.
- **`runtimeInfo()` can never hang either.** Resolved with `Serving.info` the
  moment the runtime is serving, and with `undefined` by the single `tapFailure`
  on `exited` for every route that never gets there. `start.spec.ts` →
  _"hands back what a serving runtime published about itself"_, _"resolves
  undefined for a runtime that publishes nothing"_, _"stays pending until the
  runtime is serving"_ and _"resolves undefined when the runtime never serves,
  so a caller cannot hang"_.

- **A bad environment is a modeled startup `Err`, exit `78`, and the kernel
  binds its own `PROBE_PORT` the same way.** The binding itself — field
  semantics, `Config.object`, `Config.provider` reading `Env` — is
  `@btravstack/config`'s own spec's business; the kernel's `config.spec.ts`
  guards only how the kernel reports it: `Config.provider` through `start`
  (_"fails startup with ConfigInvalid, naming the port and the variables"_ —
  the `configured` fixture's `Settings` port, bound from `StartOptions.env`
  next to an in-memory runtime; _"exits 78 under runMain"_) and the kernel's
  own `PROBE_PORT`
  (_"binds the probe server from the environment when no option is given"_
  with `PROBE_PORT=0`, _"exits 78 when PROBE_PORT is not a port"_, and the
  `RuntimeStartFailed`-for-`"probes"`-carrying-`ConfigInvalid` shape `runMain`
  reads the `78` off). `start.spec.ts` → _"reaches the exited phase when the
  runtime refuses to start"_ pins the `startFailed` event's place in the
  sequence (`building`, `startFailed`, `stopping`, `exited`).

Type-level invariants live in `start.test-d.ts` and are checked by
`pnpm typecheck`:

- **The module must export a runtime, and that runtime's declared `resolves` are
  checked against the module's exports at the `start` call site** (the phantom
  marker `StartGate<X, UnitNeeds>`, intersected onto `module`). A composition
  with no port declared over `RuntimePort` among its exports fails to match
  `NO RUNTIME — …`; a port the module does not export fails to match
  `UNSATISFIED RUNTIME PORTS — …`.
  Each arm's sentence is pinned by an `expectTypeOf<StartGate<…>>` in
  `start.test-d.ts` — `@ts-expect-error` accepts any error, so the sentence a
  reader is shown is asserted there or nowhere.
  `InstanceType<never>` is `never`, so a runtime resolving nothing works against any
  module. `Needs` and `Info` are not type parameters of `start` any more: they
  are read off `X` (`RuntimeResolvesOf<X>`, `RuntimeInfoOf<X>` — `ServiceOf` of
  `Extract<X, RuntimeInstance>`, all in `runtime.ts`; only `RuntimeInfoOf` is
  exported from the package, the rest are the gate's internals), which is what
  lets `RunningApp<E, RuntimeInfoOf<X>>` type `runtimeInfo()` from the module
  alone.
- **The gate is bypassable, deliberately — by a cast.** `start(M as never)`
  typechecks (verified), which is the ordinary TypeScript escape rather than
  anything this gate offers: the gate exists to catch the accident, not to be
  unforgeable. It used to be forgeable a second way — spelling the phantom rest
  arguments out by hand — and that went with the rest tuple; di's
  `UNSATISFIED DEPENDENCIES` gate has since made the same move
  (`DependencyGate`, issue #93), so the cast is the one escape either gate
  leaves. Nothing asserts the cast, because
  a cast defeats every gate and asserting it would pin TypeScript, not this.

`docs-examples.test-d.ts` compiles every code sample the two READMEs ship —
the `@btravstack/testing` ones (`testRuntime`, `createFakeClock`, `bootFixture`)
imported by name, since that is a separate package — and asserts the contract
types they print are **equal** to the shipped ones, so the READMEs cannot drift
from `runtime.ts` or `drain.ts` without failing the gate.

## Internal design (don't break these)

`packages/core/src/` is one concept per file.

- **`Env` is provided by wrapping, not seeding.** `start` builds
  `Module("Kernel")({ imports: [module, Module("Environment")({ provides:
[Provider(Env)({ value: env })], exports: [Env] })], exports: [module] })`
  — unless the module (or a module it imports, recursively: `providesEnv`)
  already provides `Env` itself, in which case the wrap imports the module
  alone, so an application supplying its own environment provider is not
  handed a second `Env` and di's duplicate-provider gate does not fire —
  and hands THAT to `Module.scoped`: di lets a module re-export an imported
  module, so `X` stays exactly what the caller composed, and `Env` reaches
  every provider — and every unit fork, since the built context holds all
  services, not only the exports — through the ordinary graph. The cast to
  `Module<X, E, Scope>` restates what the signature already promised
  (`Module<X, E, Scope | Env>` in, `Env` discharged here). `Port("Env")` is
  declared once, in `@btravstack/config`.

- **`PROBE_PORT` is read through the same `Config.port` field the public API
  ships**, not a private parser — one definition of what a port is — and its
  failure is wrapped in `RuntimeStartFailed({ runtime: "probes", cause:
ConfigInvalid })` rather than widening `exited`'s error union for every
  caller; `runMain`'s `isConfig` reads through that one level. `probes: false`
  or an explicit `{ port }` skips the read entirely, which is why every kernel
  spec that does not test probes passes one of them (an unset `probes` in a
  test would try to bind 9000).

- **`startFailed` is emitted from both `tapFailure` sites** — the probe bind's
  and `Module.scoped`'s — because a failed probe bind short-circuits the
  `flatMap` that would otherwise reach the second; the cause is
  `failure.tag === "Err" ? failure.error : failure.cause`, the `FailureView`
  unthrown hands a `tapFailure` callback. The second site is guarded by
  `tracker.current() !== "stopping"`: a `serving.stop()` that defects
  reaches the same `tapFailure` after `finish` has already moved the phase
  on, and that is a shutdown failure the exit report owns, not a startup one
  (`start.spec.ts` → _"does not report a shutdown defect as startFailed"_).

- **`Config.object`'s `~standard.validate` is synchronous and never throws.**
  It walks every field, so an operator sees every fault at once; a field whose
  `parse` defects (a bug in the field) is folded into an issue against its
  variable rather than thrown through a validation that promised issues.
  `Config.provider` still awaits `validate` (`fromSafePromise` over an `async`
  wrapper) because a third-party Standard Schema may be async — and may throw,
  which the wrapper turns into the defect it is.

- **The needs check is a phantom marker intersected onto `module`, not a
  trailing rest tuple.**
  `module: Module<X, E, Scope | Env> & ([InstanceType<RuntimeResolvesOf<X>>] extends [X] ? unknown : "UNSATISFIED RUNTIME PORTS — …")`
  (preceded by the `NO RUNTIME` arm on `Extract<X, RuntimeInstance>`) —
  against the module's exports alone, never the `unit` module's: a unit-only
  port exists only while a unit is open, and `RuntimeHost.ctx` is the
  application context, so accepting it would type-check into a startup defect
  (`start.test-d.ts`'s `SpanApp` pins the rejection).
  A rest tuple was the earlier spelling, on the grounds that a conditional type
  in an inference-bearing position can defer that parameter's inference and
  collapse `X` or `E` to `unknown`. It bought that safety at the cost of the
  diagnostic: a missing rest argument is an **arity** error, and an arity error
  never prints a type, so `NO RUNTIME` never reached a reader and tsc's related
  info pointed at the wrong fix ("an argument for 'options' was not provided").
  Measured: `X` still infers from `Module<X, …>` with the marker alongside, so
  the intersection costs nothing the tuple was protecting. di's own gate on
  the entry points made the same move afterwards (`DependencyGate`, issue
  #93), so the two gates are the same shape again — di's marker is an object
  ending on the missing ports where this one is a fixed sentence, which is
  each gate saying the thing it has to say.

- **The runtime is resolved from the built graph, through the one generic
  port.** `RuntimePort` is `Port("Runtime")` left generic (its construct
  signature is `new <Service>()`), so it is never itself in `X`; every runtime
  package — or application — declares a concrete port over it, and they all
  share the id `"Runtime"`. Inside `start`'s `use` callback the kernel does
  `ctx.get(RuntimePort)` through a cast, because the gate has already proven at
  the call site that a port with that id is exported, and the checker cannot
  see that proof in a body where `X` is unresolved. `runtimeName` is filled in
  there, which is why the `serving` event's `runtime` field is a `let` rather
  than read off an option. `Port("Runtime")` is called exactly once, in
  `runtime.ts`, so di's duplicate-id warning never fires however many packages
  subclass it.

- **`Context<in R>`'s contravariance is what makes the check free.** An
  application context whose exports cover what the runtime resolves is assignable to
  `Context<InstanceType<Resolves>>` with no work. The
  `ctx as unknown as Context<InstanceType<Resolves>>` inside `start`'s `use`
  callback is needed only because the gate proves `InstanceType<Needs> extends X`
  at the **call site**, and that proof is not visible to the checker inside a
  body where `X` and `Needs` are still unresolved type parameters.
  `@btravstack/testing`'s `bootFixture` has the same problem
  and solves it the same way — by forwarding through a signature with the
  phantom marker already discharged.

- **`finish` skips the drain for every reason but `"signal"` — and aborts the
  registry on exactly those paths.**
  `reason === "signal" ? runDrain(serving) : OkAsync(undefined)`, preceded by
  `if (reason !== "signal") registry.abortAll()`. `runtimeStopped` is a
  deliberate stop with nothing to wait for; `"uncaught"` is deliberately
  harsher — after an uncaught throw the process state may be corrupt, so
  draining risks completing in-flight work **wrongly**, and half-finished
  correct work beats confidently-wrong finished work. Both leave
  `ExitReport.drain` `undefined`, which is what `runMain`'s
  `report.drain?.abandoned ?? 0` reads.
  The `abortAll` is what makes that rationale true rather than merely stated:
  skipping the drain is a decision not to **wait** for in-flight work, not a
  decision to leave it running unsignalled — which would let it go on
  completing against the very corrupted state the skip exists to avoid.
  `drainApp` aborts what is still open at its deadline; these paths have no
  deadline, so they abort at once. It also stops a unit holding a ref'd socket
  from keeping the event loop alive after the report, since `runMain` never
  calls `process.exit()`.

- **The `teardownErrors` aliasing is load-bearing.** The array put on the
  `ExitReport` is the **same mutable array** `onTeardownError` pushes into. di
  closes the scope after `use` settles but before its own result settles, so
  every finaliser failure lands in the array after the object is built and
  before the caller can observe it. A defensive copy anywhere on that path would
  silently drop every teardown error.

- **`ready()` is `phase === "serving" && !forcedUnready`, and the two terms do
  not contribute equally.** On the drain path the phase term alone answers
  false — `runDrain` advances the tracker to `"draining"` synchronously before
  `drainApp` calls `onUnready`. The latch is load-bearing on exactly one path:
  the uncaught one, where the handler flips it while the phase is still
  `"serving"` because the tracker only moves a tick later. Deleting
  `!forcedUnready` is invisible to every drain test and is caught by exactly one
  assertion (named above). This is also why `ready()` is on `RunningApp` at all.

- **`runtimeInfo`'s deferred is settled exactly where `probePort`'s is.**
  `runtimePublished` takes `Serving.info` the moment the runtime is serving, and
  `undefined` from the **same two** `tapFailure` blocks that already settle
  `probeBound` — the probe bind failure, and `Module.scoped`'s (construction
  failure, a runtime refusing to start, a defect). `createDeferred.resolve` is
  idempotent, so a runtime that did serve and then failed later keeps what it
  published. One mechanism, two deferreds, no third shape.

- **The probe server binds before the graph is built.** `/livez` therefore
  answers while construction is still running, which is why there is no separate
  startup probe. A bind failure is a startup failure of its own: its
  `tapFailure` runs the same cleanup as `Module.scoped`'s, because a failed
  `probesStarted` short-circuits the `flatMap` that would otherwise reach it.
  It binds `127.0.0.1` and `unref`s the server.

- **`skipDrain` is one `AbortController` shared by both drain sleeps.** A second
  signal aborts it, cutting short whichever sleep is pending; the uncaught
  handler aborts it too. `deadline` is a **separate** controller — the one handed
  to `Serving.drain` — and is aborted the instant the race settles, on either
  branch, so a runtime that treats it as its own cue to return is always
  released.

- **`awaitIdle()` is sequenced behind the runtime's `drain`, never sampled
  alongside it.** Beat 3 is
  `drainStopped.flatMap(() => args.registry.awaitIdle())` raced against the
  timeout — not `allAsync([drainStopped, awaitIdle()])`. `awaitIdle` answers
  about the registry at the instant it is **called**, returning `OkAsync()`
  outright when nothing is open, so calling it in the same tick the runtime was
  told to stop accepting lets a unit that opens while `drain` is still resolving
  go unwaited, then be aborted and reported `abandoned` with the entire budget
  unspent. That window is wide for any runtime whose `drain` is a real wait — an
  HTTP server closing out keep-alive connections is the motivating one — and
  invisible to `@btravstack/testing`'s `testRuntime`, whose `drain` resolves
  synchronously. Guarded by
  `drain.spec.ts` → _"waits for a unit that opens while the runtime is still
  stopping accepting"_.

- **The pre-drain delay is charged from when the shutdown was REQUESTED.**
  `Math.max(0, preDrainDelayMs - sinceShutdownRequested())`, stamped by
  `requestShutdown` at the first request — the one `createDeferred` keeps. A
  signal landing mid-build is buffered, since nothing observes
  `shutdown.promise` until `runtime.start` has resolved, so paying the delay in
  full afterwards charges twice for a window the build already spent. Both
  together can exceed `terminationGracePeriodSeconds` and turn a graceful exit
  into a SIGKILL. Guarded by `start.spec.ts` → _"spends only what is left of
  preDrainDelayMs when the signal predates serving"_.

- **`startProbeServer` catches `listen`'s synchronous throw.** node validates
  the port itself and throws `ERR_SOCKET_BAD_PORT` — for a non-integer and for
  anything outside 0..65535 — rather than emitting `'error'`. Uncaught, that
  throw escapes the `new Promise` executor and reaches the caller as a
  **Defect**, bypassing the `AsyncResult<ProbeServer, RuntimeStartFailed>` the
  function declares and exiting `70` where a modeled startup failure exits `1`.
  `probes: { port: Number(process.env.PROBE_PORT) }` is how it arrives.

- **A bound server keeps an `'error'` listener for life.** `onBindError` is
  removed on success — it could only resolve an already-settled deferred — but
  it is **replaced**, not merely deleted. `net.Server` still emits `'error'`
  after listening (an accept failure such as `EMFILE`), and an unhandled
  `'error'` throws, which the kernel's own `uncaughtException` handler would
  turn into a whole-application teardown over a fault in the health endpoint.
  The socket is `unref`'d and dispose-only, so the replacement ignores rather
  than reports. `@btravstack/http`'s `httpRuntime` carries the same pair
  for the same reason.

- **`registry.closed()` is monotonic, and that is why the report is honest.**
  `completed` is `closed() - closedAtStart`. The obvious
  `inFlightAtStart - abandoned` goes negative the moment a unit starts after the
  sample and closes before the deadline.

- **`abortAll` iterates the live `Set`,** so a unit started synchronously from an
  abort listener is visited by the same pass. The `Set` holds the
  `AbortController`s, and each one's `signal` is on both the work callback's
  parameter list **and** the unit's ambient record, so one `abort()` is seen by
  a runtime that takes the parameter (`@btravstack/http`) and by one that
  cannot (`@btravstack/temporal`, `@btravstack/amqp`, whose work callback is
  the library's `next()`). Do not mirror the record's `signal` onto a second
  controller: the identity is what the guard asserts.

- **`units.ts` uses `fromSafePromise`, not `fromPromise`.** The promise cannot
  reject — the work's own throw is caught by `flatMap`'s throw-to-defect net once
  the inner `Result` is unwrapped — and there is no cause a `qualify` could
  triage into a modeled error.

- **The `unit` module forks INSIDE `registry.run`, and both halves of that
  placement are load-bearing** (`unit-module.spec.ts` guards them). Inside
  `registry.run`'s work means the fork's teardown runs while the unit's
  ambient record is still open — a span's `onStop` logs under the request's
  own trace id (_"builds and tears down inside the unit's own ambient
  record"_) — and the unit is not counted closed until the scope is, so a
  drain waits for unit teardown too (_"keeps a unit in flight until its scope
  has closed"_: the teardown is held open across `requestDrain()`, and the
  report says `inFlightAtStart: 1, completed: 1`). The fork passes its own
  `onTeardownError`, which **emits and does not push**: `teardownErrors` is
  the application scope's array and rides the exit report, and a per-unit
  finaliser failing on every request would grow it without bound (_"reports
  a failing unit teardown as an event and keeps it off the exit report"_).
  `run` stays an **annotation** against
  `RunUnit` (a divergence is reported, not absorbed); with no `unit` option
  the work receives `runtimeCtx` exactly as before, zero overhead. The
  `forkScope` call goes through a discharged-signature cast — the same move
  `runMain` and `@btravstack/testing`'s `bootFixture` make on `start` — because
  the fork's gates are
  proven by `start`'s intersected marker at the call site and invisible in a body
  where `X`, `Needs` and `UnitX` are unresolved. The work's return union is
  normalised by an `async` wrapper exactly as `registry.run` does it.

- **`options.signals === false` disables the uncaught handlers too.** One flag,
  two handler families, because both are process-global and a test harness needs
  all of them off together. Worth knowing before reading the option's name as
  narrower than it is.

- **Only the first uncaught exception or unhandled rejection is reported.** The
  shutdown it triggers may produce further noise, and the exit report names one
  cause.

- **The `stop()`/`requestDrain()` deferred resolves once.** `createDeferred`
  guards `resolve` with an explicit `settled` flag (a second SIGTERM, and the
  uncaught handler racing a signal, both call it again), so nothing can rewrite
  the reason an application stopped. There is deliberately no `settled()`
  accessor — nothing asks, and an unread accessor is dead code the compiler
  cannot see.
