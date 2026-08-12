# packages/start

The kernel's internals. The root `CLAUDE.md` is still the authoritative spec
for what this package **is** — the thesis, the public surface and the
conventions live there; this file holds the two sections that only matter when
you are editing `packages/start` itself. Both are load-bearing: keep them in
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

Type-level invariants live in `start.test-d.ts` and are checked by
`pnpm typecheck`:

- **A runtime's declared `needs` are checked against the module's exports at the
  `start` call site** (the phantom rest-tuple gate). A missing port does not
  compile. `InstanceType<never>` is `never`, so a needs-free runtime works
  against any module.
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

`packages/start/src/` is one concept per file.

- **The needs check is a trailing phantom rest tuple, not a conditional on an
  inference-bearing parameter.**
  `...gate: [InstanceType<Needs>] extends [X] ? [] : [error: "UNSATISFIED RUNTIME NEEDS", missing: …]`.
  A conditional type on `module` or `options` would make TypeScript defer that
  parameter's inference and can collapse `X` or `E` to `unknown` — the same
  shape, and the same reasoning, as di's own gate on `Module.scoped`, and the
  same rule unthrown records for `fromPromise`. It **is** bypassable by a caller
  who hand-writes the phantom arguments (proved in `start.test-d.ts`); that is
  accepted, exactly as di accepts it.

- **`Context<in R>`'s contravariance is what makes the check free.** An
  application context whose exports cover the runtime's needs is assignable to
  `Context<InstanceType<Needs>>` with no work. The
  `ctx as unknown as Context<InstanceType<Needs>>` inside `start`'s `use`
  callback is needed only because the gate proves `InstanceType<Needs> extends X`
  at the **call site**, and that proof is not visible to the checker inside a
  body where `X` and `Needs` are still unresolved type parameters. `withApp` has
  the same problem and solves it the same way — by forwarding through a
  signature with the phantom tuple already discharged.

- **`finish` skips the drain for every reason but `"signal"`.**
  `reason === "signal" ? runDrain(serving) : OkAsync(undefined)`. `runtimeStopped` is
  a deliberate stop with nothing to wait for; `"uncaught"` is deliberately
  harsher — after an uncaught throw the process state may be corrupt, so
  draining risks completing in-flight work **wrongly**, and half-finished
  correct work beats confidently-wrong finished work. Both leave
  `ExitReport.drain` `undefined`, which is what `runMain`'s
  `report.drain?.abandoned ?? 0` reads.

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

- **`RunUnit` is typed for a per-unit fork it does not yet perform.** `start`
  builds `run` as `(meta, work) => registry.run(meta, (signal) => work(runtimeCtx, signal))`
  — an **annotation**, not an assertion, so a future divergence from `RunUnit` is
  reported here rather than absorbed. When the `unit` module lands, the
  `Module.forkScope` call goes exactly there, replacing `runtimeCtx` with the
  fork's context; no signature changes.

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
