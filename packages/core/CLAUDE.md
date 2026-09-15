# packages/core

The kernel's internals, and the reasoning behind its public surface — the
surface itself is `docs/reference/core/`. The root `CLAUDE.md` carries the
thesis and the conventions. The sections below are load-bearing: keep them in
sync with the code in the same commit.

## Public surface

- **`start(module, options?)`** — the gate (`StartGate<X, N>`) and its arms
  are `docs/reference/core/start.md`'s. A `Runtime` phantom carrying a
  `fork` module's needs through this marker was tried and reverted: every
  shipped runtime port fixes its `Runtime` argument at declaration
  (`class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}`), so
  the phantom's arm was unreachable for every runtime the repository ships,
  and reaching it would have meant making every runtime port generic — a wall
  documented at `RuntimePort` below.

  **Why needs are checked first, and why in di's words.** The parameter used to
  be `Module<X, E, Scope | Env>`, so an unmet need was a plain assignability
  failure printing `Type 'HttpRouterPort' is not assignable to type 'Scope'` —
  an internal phantom a reader has never heard of — and when the port was
  missing from `exports` too, the arm that fired was `UNSATISFIED RUNTIME
PORTS`, a correct diagnosis of the second mistake that reads as a wrong one
  of the first and steers the fix into `exports` when it belongs in `provides`.
  The id rather than the port type is what keeps a starter's own generic port
  readable: `AmqpHandlers` as a TYPE is its contract expanded, hundreds of
  characters truncated before a name is reached.
  `unknown` is the satisfied arm, and it has to be: intersecting `unknown`
  leaves the module type untouched, so a good call infers exactly as it
  would without the marker.

- **`traceIdOfTraceparent(header)`** — hoisted here for the same reason
  `releasedBy` was (#24's shape): it was duplicated verbatim in
  `@btravstack/http-server` and `@btravstack/amqp-worker`, and two copies of a
  parser is two places for the all-zero rule to be forgotten. Its semantics are
  `docs/reference/core/runtime.md`'s.

- **`releasedBy(signal, running)`** — its semantics are
  `docs/reference/core/runtime.md`'s; it races `running` against a private
  `whenAborted(signal)`. Hoisted here in #24, where it was duplicated verbatim
  in `@btravstack/temporal-worker` and
  `@btravstack/amqp-worker` with divergent TSDoc; it is runtime-author toolkit,
  which is why it sits beside the `Runtime` contract rather than in a shared
  internal. The losing branch's `Result` is **dropped** — once the deadline
  wins the kernel has moved on and nothing consumes the outcome. `whenAborted`
  stays private: `releasedBy` is the whole use case, and its already-aborted
  arm is load-bearing, since `addEventListener` on an aborted signal never
  fires and the race would hang.
- **`RuntimePort`** — its declaration, and why every runtime port shares one
  id, are `docs/reference/core/runtime.md`'s. `RuntimeOf<X>` /
  `RuntimeResolvesOf<X>` / `RuntimeInfoOf<X>` read a runtime's `Resolves` and
  `Info` back out of a module's exports (only
  `RuntimeInfoOf` is exported — the other two are the gate's internals);
  `RuntimeInstance` is the shared instance type
  (`InstanceType<PortClass<"Runtime">>`, internal too). The two helper types
  read `resolves`/`start` **structurally, field by field**, rather than
  through `RuntimeOf<X> extends Runtime<..., infer T>`: matching the whole
  alias forces a full structural comparison across every parameter at once,
  which is what broke — silently, for any `never`-Resolves runtime
  (`testRuntime`'s inferred `Info` as `never`) — the one time `Runtime`
  briefly carried a third, optional phantom parameter (see the note on
  `start`'s marker above for why that phantom is gone). The structural form
  survives the revert because it is the sturdier one regardless, not because
  `Runtime` is back to two parameters. Every
  runtime package ships its port and a starter — `HttpRuntime`/`http()`,
  `TemporalRuntime`/`temporal()`, `AmqpRuntime`/`amqp()` — and none of them
  has a `resolves` any more: each takes the application's router / activities /
  handlers as a **port its runtime provider depends on** through di — the
  starter's own fixed port (`OrpcRouterPort`, `TemporalActivitiesPort`,
  `AmqpHandlersPort`, one id each; the temporal and amqp ones typed per
  contract at the type level, the same generic-value move `RuntimePort`
  itself makes), which the application provides and never names — so their
  `Resolves` is `never` and `RuntimeHost.ctx` goes unread by every shipped
  runtime. The kernel keeps `Runtime.resolves`, `RuntimeHost`/`UnitHost`'s
  typed `ctx` and the
  `UNSATISFIED RUNTIME PORTS` arm as the general contract (`testRuntime` and a
  hand-rolled runtime still use it), but no starter does. A port's service
  type is fixed at declaration, which is why a runtime with application-specific
  needs could not ship its port — the reason the needs went, not a constraint
  to work around.

### Health checks

The `HealthChecks` list is **late-bound**: probes answer from `building`
onward, which is before the graph declaring the checks exists, so `start` fills
a holder once `Module.scoped` hands it a context. Until then `/healthz` reports
healthy with no components, which is the honest answer while building. The
surface is `docs/reference/core/probes.md` and `src/health.ts`.

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
   together, and `@btravstack/temporal-worker`'s and `@btravstack/amqp-worker`'s own
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

- **Every phase has a deadline, and the two that did not were where a shutdown
  wedged.** `stopTimeoutMs` bounds `stopping` — `Serving.stop` **and** di's
  finalisers, which is why the race sits on `Module.scoped` rather than inside
  `finish`, whose `.map` returns before a single `release` has run — and a
  crash or a **second** signal before `serving` abandons the build. Both report
  `ExitReport.abandonedAt` with a `stoppedWaiting` event, and `runMain` reads
  the field as exit `2`. Guarded by `start.spec.ts` → _"reports a stop whose
  finalisers outlive stopTimeoutMs, instead of never reporting"_, _"cuts the
  stop wait short on a second signal, naming no deadline"_, _"reports an
  uncaught exception raised while the graph is still building"_ and _"gives up
  on a build a second signal has given up on"_ — all four hang forever against
  the pre-fix kernel, which is the reported symptom rather than a wrong value.
  Two things are load-bearing in the implementation: the deadline arm's guard
  is `lifecycleSettled`, set when `Module.scoped` settles and **not** when
  `serving.stop()` returns (the gap between them is the whole bug), and
  `clock.sleep` RESOLVES on abort, so reading the signal instead of the flag
  reported a timeout on every clean stop. A FIRST signal mid-build stays
  buffered — invariant "spends only what is left of preDrainDelayMs" depends on
  it.
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
- **`/healthz` answers whatever the checks do — a buggy check can neither hang
  the endpoint nor take the application down.** A check whose `AsyncResult`
  defects, and one that throws synchronously instead of answering, are both
  recovered into an unhealthy component line inside `runHealthChecks` — each
  check is started inside the pipeline, so the throw lands in a combinator's
  net rather than escaping the probe server's request listener into the
  kernel's own `uncaughtException` handler, and the defect never reaches the
  dropped `void args.health()` in `probes.ts`, which would otherwise leave the
  response unwritten. `health.spec.ts` → _"reports a component whose check
  defects as unhealthy, instead of losing the report"_ and _"contains a check
  that throws synchronously, instead of letting it escape the fold"_.
- **No `Result` is produced and left unexamined — with exactly three audited
  exceptions, each carrying its reason inline.** `AsyncResult<T, never>` empties
  the **error** channel only; a `Defect` can still be there, and a `Serving`
  written by a third party is where one comes from. `drain.spec.ts`'s four
  _"propagates a Defect from …"_ tests guard the drain;
  `packages/testing/src/boot-fixture.spec.ts` → _"fails the test on a shutdown
  defect, and only on a defect"_ the fixture. The three
  survivors are `start.ts`'s `void server.close()` (our own `fromSafePromise`
  over `server.close(cb)`, so no third-party code can defect inside it — and it
  must not be awaited: the socket is `unref`'d and `close` waits out live
  keep-alive connections, which would delay or strand the exit report),
  `drain.ts`'s losing race branch (once the timeout has decided the report,
  `exited` has settled and a late defect has no consumer left), and
  `probes.ts`'s `void args.health()` (`runHealthChecks` recovers every failure
  and defect into the report, so the `.map` writing the response always
  runs — see the `/healthz` invariant above). None can
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
  binds its own three variables the same way.** The binding itself — field
  semantics, `Config.object`, `Config.provider` reading `Env` — is
  `@btravstack/config`'s own spec's business; the kernel's `config.spec.ts`
  guards only how the kernel reports it: `Config.provider` through `start`
  (_"fails startup with ConfigInvalid, naming the port and the variables"_ —
  the `configured` fixture's `Settings` port, bound from `StartOptions.env`
  next to an in-memory runtime; _"exits 78 under runMain"_) and the kernel's
  own variables
  (_"binds the probe server from the environment when no option is given"_
  with `PROBE_PORT=0`, _"exits 78 when PROBE_PORT is not a port"_, _"reports
  every variable the kernel itself could not read, in one failure"_ — the
  `RuntimeStartFailed`-for-`"kernel"`-carrying-`ConfigInvalid` shape `runMain`
  reads the `78` off — and _"binds the drain timings from the environment when
  nothing pins them"_, which reads the two sleeps off a stub clock rather than
  off wall time). `start.spec.ts` → _"reaches the exited phase when the
  runtime refuses to start"_ pins the `startFailed` event's place in the
  sequence (`building`, `startFailed`, `stopping`, `exited`).

Type-level invariants live in `start.test-d.ts` and are checked by
`pnpm typecheck`:

- **The module must export a runtime, and that runtime's declared `resolves` are
  checked against the module's exports at the `start` call site** (the phantom
  marker `StartGate<X, N>`, intersected onto `module`). A composition
  with no port declared over `RuntimePort` among its exports fails to match
  `NO RUNTIME — …`; a port the module does not export fails to match
  `UNSATISFIED RUNTIME PORTS — …`; a module whose own needs are unprovided
  fails to match `{ "UNSATISFIED DEPENDENCIES — nothing provides": <the port's
id> }`, which is checked before either.
  Each arm's diagnostic is pinned by an `expectTypeOf<StartGate<…>>` in
  `start.test-d.ts` — `@ts-expect-error` accepts any error, so the sentence a
  reader is shown is asserted there or nowhere.
  `InstanceType<never>` is `never`, so a runtime resolving nothing works against any
  module. What the runtime resolves and its `Info` are not type parameters of
  `start`: they are read off `X` (`RuntimeResolvesOf<X>`, `RuntimeInfoOf<X>` — `ServiceOf` of
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

## Internal design (don't break these)

`packages/core/src/` is one concept per file.

- **`Env` is provided by wrapping, not seeding.** `start` wraps the module in a
  `Kernel` module that imports it beside an `Environment` module providing
  `Env` from `StartOptions.env`, and re-exports it (`src/start.ts`) — unless
  the module (or a module it imports, recursively: `providesEnv`) already
  provides `Env` itself, in which case the wrap imports the module alone, so an
  application supplying its own environment provider is not handed a second
  `Env` and di's duplicate-provider gate does not fire — and hands THAT to
  `Module.scoped`: di lets a module re-export an imported module, so `X` stays
  exactly what the caller composed, and `Env` reaches every provider — and
  every unit fork, since the built context holds all services, not only the
  exports — through the ordinary graph. The cast to `Module<X, E, Scope>`
  restates what `StartGate` proved at the call site: `N` owes nothing beyond
  `Scope | Env`, and the wrap discharges `Env`. `Port("Env")` is declared once,
  in `@btravstack/config`.

- **The kernel's own variables are read in ONE pass**, by `readKernelConfig`:
  `PROBE_PORT`, `PRE_DRAIN_DELAY_MS`, `DRAIN_TIMEOUT_MS` and `STOP_TIMEOUT_MS` through the same
  `Config.object` + `Config.pinned` the public API ships — not a private
  parser, so there is one definition of what a port is and one of what a whole
  number is, and a deployment that got two of them wrong is told both at once.
  Each `StartOptions` field pins its own variable; `probes: false` pins the
  default port and so reads nothing, which is why every kernel spec that does
  not test probes passes `probes: false` (an unset `probes` in a test would
  try to bind 9000).

  The failure is wrapped in `RuntimeStartFailed({ runtime: "kernel", cause:
ConfigInvalid })` rather than widening `exited`'s error union for every
  caller; `runMain`'s `isConfig` reads through that one level. The timings fall
  back to their defaults when the read fails, which changes nothing observable:
  the same failure is what `exited` reports, and no drain happens after it.

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
  trailing rest tuple.** The marker is `StartGate<X, N>` (`src/start.ts`), and
  its arms run in order: `UNSATISFIED DEPENDENCIES` on `N` first, then
  `NO RUNTIME`, then `UNSATISFIED RUNTIME PORTS` on `RuntimeResolvesOf<X>` —
  the last checked against the module's exports alone, never a fork's: a port
  a `fork` module provides exists only in the `Context` `fork` hands back, and `RuntimeHost.ctx`
  is the application context, so a runtime naming it in `resolves` would
  type-check into a startup defect (`start.test-d.ts`'s `SpanApp` pins the
  rejection).
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
  callback (`Resolves` being `RuntimeResolvesOf<X>`, `src/start.ts`) is needed
  only because `StartGate` proves at the **call site** that the module's
  exports cover what the runtime resolves, and that proof is not visible to the
  checker inside a body where `X` is still an unresolved type parameter.
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
  failure, a runtime refusing to start, a defect). A `Promise.withResolvers`
  `resolve` is idempotent — a second call is a no-op, which is what the
  hand-rolled `createDeferred` needed a `settled` flag for — so a runtime that
  did serve and then failed later keeps what it published. One mechanism, two
  deferreds, no third shape.

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
  `requestShutdown` at the first request — the one `shutdownRequestedAt`
  keeps. A
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
  than reports. `@btravstack/http-server`'s `httpRuntime` carries the same pair
  for the same reason.

- **`registry.closed()` is monotonic, and that is why the report is honest.**
  `completed` is `closed() - closedAtStart`. The obvious
  `inFlightAtStart - abandoned` goes negative the moment a unit starts after the
  sample and closes before the deadline.

- **`abortAll` iterates the live `Set`,** so a unit started synchronously from an
  abort listener is visited by the same pass. The `Set` holds the
  `AbortController`s, and each one's `signal` is on both the work callback's
  parameter list **and** the unit's ambient record, so one `abort()` is seen by
  a runtime that takes the parameter (`@btravstack/http-server`) and by one that
  cannot (`@btravstack/temporal-worker`, `@btravstack/amqp-worker`, whose work callback is
  the library's `next()`). Do not mirror the record's `signal` onto a second
  controller: the identity is what the guard asserts.

- **`units.ts` uses `fromSafePromise`, not `fromPromise`.** The promise cannot
  reject — the work's own throw is caught by `flatMap`'s throw-to-defect net once
  the inner `Result` is unwrapped — and there is no cause a `qualify` could
  triage into a modeled error.

- **The fork is the runtime's to START, through `UnitHost.fork`, and the
  kernel's to CLOSE — and both halves of that split are load-bearing**
  (`unit-module.spec.ts` guards them). `fork` calls `Module.forkScope` with a
  `use` callback that resolves the built `Context` to the caller (through a
  `Promise.withResolvers` named `ready`) and then **holds the scope open**
  by returning a second deferred (`settled`) that only resolves once the
  unit's own work has settled — so the fork's teardown still runs while the
  unit's ambient record is open — a span's `onStop` logs under the request's
  own trace id (_"builds and tears down inside the unit's own ambient
  record"_) — and the unit is not counted closed until the scope is, because
  `run`'s `finally` awaits the fork's `closing` promise before letting
  `registry.run`'s own callback return (_"keeps a unit in flight until its
  scope has closed"_: the teardown is held open across `requestDrain()`, and
  the report says `inFlightAtStart: 1, completed: 1`). The fork passes its
  own `onTeardownError`, which **emits and does not push**: `teardownErrors`
  is the application scope's array and rides the exit report, and a per-unit
  finaliser failing on every request would grow it without bound (_"reports
  a failing unit teardown as an event and keeps it off the exit report"_). A
  construction failure — the module never reaches `use` — is recovered onto
  `ready.reject(cause)` before `.get()` resolves `closing`, so the caller's
  `fork(...)` call settles as a `Defect` instead of hanging forever
  (_"recovers a fork's construction failure onto the caller's defect
  path"_). A unit forks once: a second `fork` call sees `closing` already set
  and short-circuits into a rejected promise, `"a unit forks its scope
once"` (_"reports a second fork in one unit as a defect"_) — two open
  scopes per unit is the design this rejects, not an oversight. A fork
  issued **after** the unit has settled is a defect on its own separate
  latch (`hasSettled`, set in the same `finally` that resolves `settled`),
  `"a unit forks after it has already settled"`: nothing awaits such a
  scope, so nothing would supervise its `onStop` (_"reports a fork issued
  after the unit has already settled as a defect"_). With no
  runtime-side `fork` call at all, the work receives `{ ctx: runtimeCtx,
fork }` and never opens a second scope, zero overhead beyond the `fork`
  closure itself.

- **`options.signals === false` disables the uncaught handlers too.** One flag,
  two handler families, because both are process-global and a test harness needs
  all of them off together. Worth knowing before reading the option's name as
  narrower than it is.

- **Only the first uncaught exception or unhandled rejection is reported.** The
  shutdown it triggers may produce further noise, and the exit report names one
  cause.

- **The `stop()`/`requestDrain()` deferred resolves once**, and that is the
  platform's promise rather than a guard of ours: `Promise.withResolvers`'
  `resolve` is idempotent, so the second SIGTERM — and the uncaught handler
  racing a signal — cannot rewrite the reason an application stopped.

`Observers` (`src/observation.ts`), the set port every starter reports
through: the reasoning is the root `CLAUDE.md`'s _Observability is a set port,
never a flag_, and the surface is `docs/reference/core/observability.md`.
`observed(observers, operation, call, settled?)` is `observe` wrapped around
one `() => AsyncResult<T, E>`, settling from whichever channel the call comes
back on, with `settled.ok` / `settled.failure` replacing either default where a
starter has more to say. It exists so cache, mailer and storage do not each
carry the same `tap`/`tapFailure` pair; `observation.spec.ts`'s `observed`
block pins both defaults, the defect arm and both hooks.
