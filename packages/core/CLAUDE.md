# packages/core

The kernel's internals. The root `CLAUDE.md` is still the authoritative spec
for what this package **is** — the thesis, the public surface and the
conventions live there; this file holds the two sections that only matter when
you are editing `packages/core` itself. Both are load-bearing: keep them in
sync with the code in the same commit.

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
   honouring `Serving.drain(signal)` — `testRuntime` deliberately ignores that
   signal, which is what makes it a test of the kernel.
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
- **The phase tracker is monotonic.** `phase.spec.ts` → _"refuses to move
  backwards and reports nothing"_ and _"treats re-entering the same phase as a
  no-op"_.
- **A throwing event sink cannot take the process down mid-shutdown.**
  `events.spec.ts` → _"swallows a throwing sink"_.
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
  _"propagates a Defect from …"_ tests guard the drain; `with-app.spec.ts` →
  _"surfaces a shutdown Defect that `use` never looked at"_ and _"lets a failure
  thrown by `use` win over a shutdown Defect"_ guard the harness. The two
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

- **The module must export a runtime, and that runtime's declared `needs` are
  checked against the module's exports at the `start` call site** (the phantom
  rest-tuple gate, `StartGate<X, UnitNeeds>`). A composition with
  no port declared over `RuntimePort` among its exports fails on arity with
  `NO RUNTIME`; a missing need fails with `UNSATISFIED RUNTIME NEEDS`.
  `InstanceType<never>` is `never`, so a needs-free runtime works against any
  module. `Needs` and `Info` are not type parameters of `start` any more: they
  are read off `X` (`RuntimeNeedsOf<X>`, `RuntimeInfoOf<X>` — `ServiceOf` of
  `Extract<X, RuntimeInstance>`, all in `runtime.ts`; only `RuntimeInfoOf` is
  exported from the package, the rest are the gate's internals), which is what
  lets `RunningApp<E, RuntimeInfoOf<X>>` type `runtimeInfo()` from the module
  alone.
- **The gate is bypassable, deliberately.** A caller who spells the phantom
  arguments out by hand (`start(M, o, "UNSATISFIED RUNTIME NEEDS", new Clock())`)
  does typecheck — asserted, not assumed. This is the same escape hatch di's own
  UNSATISFIED DEPENDENCIES gate leaves: it takes a deliberate act, and the gate
  exists to catch the accident, not to be unforgeable.

`docs-examples.test-d.ts` compiles every code sample the two READMEs ship, and
asserts the contract types they print are **equal** to the shipped ones — so the
READMEs cannot drift from `runtime.ts` or `drain.ts` without failing the
gate.

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

- **The needs check is a trailing phantom rest tuple, not a conditional on an
  inference-bearing parameter.**
  `...gate: [InstanceType<RuntimeNeedsOf<X>>] extends [X] ? [] : [error: "UNSATISFIED RUNTIME NEEDS", missing: …]`
  (preceded by the `NO RUNTIME` arm on `Extract<X, RuntimeInstance>`) —
  against the module's exports alone, never the `unit` module's: a unit-only
  port exists only while a unit is open, and `RuntimeHost.ctx` is the
  application context, so accepting it would type-check into a startup defect
  (`start.test-d.ts`'s `SpanApp` pins the rejection).
  A conditional type on `module` or `options` would make TypeScript defer that
  parameter's inference and can collapse `X` or `E` to `unknown` — the same
  shape, and the same reasoning, as di's own gate on `Module.scoped`, and the
  same rule unthrown records for `fromPromise`. It **is** bypassable by a caller
  who hand-writes the phantom arguments (proved in `start.test-d.ts`); that is
  accepted, exactly as di accepts it.

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
  application context whose exports cover the runtime's needs is assignable to
  `Context<InstanceType<Needs>>` with no work. The
  `ctx as unknown as Context<InstanceType<Needs>>` inside `start`'s `use`
  callback is needed only because the gate proves `InstanceType<Needs> extends X`
  at the **call site**, and that proof is not visible to the checker inside a
  body where `X` and `Needs` are still unresolved type parameters. `withApp` has
  the same problem and solves it the same way — by forwarding through a
  signature with the phantom tuple already discharged.

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
  invisible to `testRuntime`, whose `drain` resolves synchronously. Guarded by
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
  abort listener is visited by the same pass.

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
  `withApp` and `runMain` make on `start` — because the fork's gates are
  proven by `start`'s rest tuple at the call site and invisible in a body
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
