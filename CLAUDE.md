# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository. It is the authoritative spec — the rules _and_ the
reasoning behind them. Keep it in sync with the code as the package evolves
(describe what _is_, not what was planned).

## What this is

`@btravstack/start` — the application kernel. It boots a
[`@btravstack/di`](https://github.com/btravstack/di) module into a running
process with one runtime, drains in-flight work on SIGTERM, and closes the
application scope on every path. It owns three things — the lifecycle state
machine, the unit-of-work registry, and the `Runtime` contract — and knows
nothing about HTTP, AMQP or Temporal.

`di` proves the wiring before the process exists. `start` owns **when** an
already-proven graph is constructed and torn down, and nothing more. Nothing
throws to callers: every fallible operation returns an
[`unthrown`](https://github.com/btravstack/unthrown) `Result`.

pnpm workspace + turbo monorepo. `packages/start` is the single published
package; there are no other workspaces yet.

## Commands

Node `>=22.19` (root `engines` floor; `.node-version` pins the dev version),
pnpm `11.7.0`. The published package separately claims `>=20`.

The gate — every change must keep all six green, and CI runs the same set:

```sh
pnpm format --check   # oxfmt (run without --check to auto-fix)
pnpm lint             # oxlint, incl. all eight @unthrown/oxlint rules
pnpm typecheck        # tsc, incl. the type-level *.test-d.ts files
pnpm knip             # dead code / unused deps
pnpm test             # vitest + v8 coverage (100% lines/functions, enforced)
pnpm build            # tsdown dual CJS/ESM + d.ts
```

Root scripts fan out through turbo. To scope to one file:

```sh
cd packages/start
pnpm vitest run src/drain.spec.ts
pnpm vitest run -t "counts a unit still open at the deadline as abandoned"
pnpm test:types       # the type-level tests alone
```

Commits follow Conventional Commits (commitlint via a lefthook `commit-msg`
hook). User-facing changes need a changeset.

## Thesis (do not drift from these)

1. **One process, one runtime.** The kernel knows several runtime _kinds_; a
   process boots exactly one. An `api`, a `consumer` and a `worker` deployment
   are three processes booting the **same** module with a different runtime.
   They scale, fail and deploy independently — which is what Kubernetes wants
   anyway — and it deletes a whole class of design problem: there is never a
   question of how two runtimes in one process share a drain deadline, or whose
   failure takes the process down. `StartOptions.runtime` is therefore a single
   value, not an array, and no future option should make it plural.

2. **Ambient carries DATA. The DI `Context` carries CAPABILITIES.** The kernel
   opens one `AsyncLocalStorage` store per unit holding a small, fixed record —
   `{ unitId, traceId, tenantId, deadline }` (`UnitRecord` in `ambient.ts`) —
   and nothing else. Services never go in it. The line holds because what `di`
   exists to prevent is hidden _dependencies_: code that secretly needs a
   collaborator it never declared and cannot be tested without it. A trace id is
   not a collaborator — no substitutability question, no test double, nothing to
   swap. A repository pulled from an ambient store is the untestable coupling; a
   tenant id read by the Postgres adapter is not. Legitimate readers are
   infrastructure adapters only (logger, OTel exporter, database adapter);
   application code reading the store is meant to be a lint error, in the spirit
   of `unthrown/no-catch-all-pattern` stating unthrown's own default. **That
   rule does not exist yet** — it needs a way to identify an adapter, a
   convention this stack has not established — so today it is a documented
   convention with no enforcement. Do not describe it as enforced.

3. **The kernel never maps an outcome to a transport.** `Result` → HTTP status
   belongs to `@btravstack/start-http`, `Result` → ack/nack/DLQ to
   `-amqp`, `Result` → activity failure to `-temporal`. `RunUnit` is
   transparent to the work's own channels: whatever `Result` a handler produces
   is what the runtime receives back (`units.ts`'s `run` ends in
   `.flatMap((result) => result)` — it observes only that the unit _settled_).
   Nothing in this package may grow a status code, a retry policy, or a
   serialisation format.

4. **`start` never throws and never calls `process.exit`.** It returns a
   `RunningApp` whose `exited` is an `AsyncResult<ExitReport, E | RuntimeStartFailed>`,
   and every failure route lands in one of those channels. `runMain` is the one
   place a process's fate is decided, and it sets `process.exitCode` rather than
   calling `process.exit()` — so pending output flushes, an embedding host keeps
   control of its own lifetime, and a test can observe the code without ending
   the run. This is what makes the kernel embeddable: a dev runner booting two
   applications side by side, or a test file booting a dozen.

5. **Draining is three beats, and beat 2 is the whole point.**
   (1) Readiness flips false and the unit counts are sampled, synchronously,
   before anything else. (2) The kernel waits `preDrainDelayMs` (default
   `5_000`) **before** telling the runtime to stop accepting. (3) In-flight
   work gets `drainTimeoutMs` (default `20_000`); whatever is still open at the
   deadline is aborted and reported `abandoned`.
   Beat 2 looks like a pointless sleep and is not: **Kubernetes endpoint removal
   is eventually consistent**, so a pod that stops accepting the instant SIGTERM
   lands rejects traffic the ingress is still routing to it. That window is what
   the delay closes, and shipping the fix as a default is worth more than most
   of the framework. `drainTimeoutMs` sits deliberately under the k8s
   `terminationGracePeriodSeconds` default of 30s, leaving headroom for
   `stopping` before SIGKILL; raise one and you must raise the other.
   Only a **signal** drains — `stop()` and an uncaught exception both go
   straight to `stopping`, leaving `ExitReport.drain` `undefined`.

6. **Every async API returns an `AsyncResult`, never a bare `Promise`.** Not
   only the fallible ones: `AsyncResult<T, never>` is this package's spelling of
   "async, and cannot fail", which is what `fromSafePromise` produces. The point
   is uniformity — every async surface awaits into a `Result`, so a caller never
   has to remember which ones did and which ones did not. `probePort()`,
   `Clock.sleep`, `FakeClock.advance`, `UnitRegistry.awaitIdle`,
   `TestRuntime.untilStarted` and `ProbeServer.close` all carry `E = never`.
   `unthrown/prefer-async-result` cannot enforce this — it only flags a
   `Promise<Result<T, E>>`, and a `Promise<void>` is not Result-bearing — so it
   is a convention held by review. There are exactly **three** exceptions, each
   documented where it lives:
   - **`runMain`** returns `Promise<void>`. Its whole job is to leave the Result
     world and become a process exit code; it is the boundary, and a top-level
     `await runMain(...)` in an entry point is the intended shape.
   - **`UnitWork`'s `Promise<Result<T, E>>` arm** exists to accept a _caller's_
     `async` handler, and carries a reasoned `prefer-async-result` disable in
     `units.ts`.
   - **`withApp` and its `use` callback.** `use` is the test body: a thrown
     assertion failure inside it must reach the test runner, and an
     `AsyncResult` never rejects — converting either side would turn a failing
     `expect` into a `Defect` a caller can forget to unwrap, i.e. a green test
     that asserted nothing (`invariants.spec.ts`'s _"8. start neither throws nor
     calls process.exit"_ is exactly that shape). `A` is the test author's own
     type and carries no error channel, so the wrapper would add no information
     either.

7. **The startup error channel is the application's own, unwrapped.** The kernel
   does **not** wrap a construction failure in a kernel error — that would erase
   the module's modeled error type. `Module.scoped` already reports the module's
   `E`, so `start` returns `AsyncResult<ExitReport, E | RuntimeStartFailed>` and
   the application's own errors pass through still typed. `RuntimeStartFailed`
   is the only error the kernel mints, because it is genuinely the kernel's own
   (a port in use, a broker unreachable, a probe port taken).

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
  `ambient.spec.ts` → _"does not leak between concurrent units"_.
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
READMEs cannot drift from `runtime.ts` or `drain-report.ts` without failing the
gate.

## A known footgun: `start` without `runMain` exits 0 after a crash

`start` installs `uncaughtException` and `unhandledRejection` handlers, and
**installing either suppresses Node's own default exit code of `1`** (measured:
a process that throws from a timer exits `1` bare and `0` with a no-op handler
installed). So an embedder who uses `start` **without** `runMain`, and sets no
exit code of its own, gets a **silent exit `0` after a crash** — the process
reports success to its orchestrator.

`runMain` closes this, which is exactly why `reason === "uncaught"` maps to `70`
rather than `0`. An embedder that will not use `runMain` must fold
`ExitReport.reason` into an exit code itself, or pass `signals: false` (which
turns off the uncaught handlers, at the cost of the signal-driven drain).
Stated in both READMEs; found in Task 12's review, and it is the reason the
`uncaught` row exists in the exit-code table at all.

## Public surface

`packages/start/src/index.ts` is the one place the API is decided. `testing.ts`
is a second entry point (`@btravstack/start/testing`), kept out of the main one
so a production bundle never pulls the fakes in.

### `@btravstack/start`

- **`start(module, options)` → `RunningApp<E>`** — the entry point. Takes a
  `Module<X, E, Scope>` (not `Module<X, E, never>`: `Needs` is covariant on
  `Module`, so this accepts both a needs-free module and the resourceful one
  whose `acquire`/`release` provider adds `Scope` — the single need
  `Module.scoped` discharges itself). Followed by the phantom `...gate` rest
  tuple that makes the runtime's needs a compile-time check.
- **`StartOptions<Needs>`** — `runtime` (required); `clock`
  (default `systemClock`); `signals` (default `true`; **`false` disables the
  SIGTERM/SIGINT handlers _and_ the uncaught ones together**); `probes`
  (default `{ port: 9000 }`, or `false`); `preDrainDelayMs` (`5_000`);
  `drainTimeoutMs` (`20_000`); `onEvent` (default `stderrSink`).
- **`RunningApp<E>`** — `exited` (`AsyncResult<ExitReport, E | RuntimeStartFailed>`),
  `stop()`, `requestDrain()`, `phase()`, `ready()`, `probePort()`.
  `stop()` exits without draining; `requestDrain()` takes the signal path.
  `ready()` is the synchronous read of the same predicate `/readyz` answers
  from — needed because the uncaught path forces it false while the phase is
  still `"serving"`, a window no HTTP round trip fits inside; it is also what an
  embedder wires into a health endpoint of its own when `probes: false`.
  `probePort()` is an `AsyncResult<number | undefined, never>` resolving the
  port actually bound (the point of it is `{ port: 0 }`), or `undefined` when
  probes are disabled or the bind failed.
- **`ExitReport`** — `reason` (`"signal" | "runtimeStopped" | "uncaught"`),
  `drain` (`DrainReport | undefined` — `undefined` whenever the drain was
  skipped), `teardownErrors`, `uptimeMs`. **`TeardownError`** is
  `{ port, cause }`.
- **`DrainReport`** — `inFlightAtStart` (units in flight when the drain began),
  `completed` (units that **closed during** the drain — it may exceed
  `inFlightAtStart` if in-flight work spawned more, which is honest reporting,
  not a bug), `abandoned` (units still open at the deadline; **the field the
  exit code keys on**).
- **`Runtime<Needs>` / `RuntimeHost<Needs>` / `RunUnit<Needs>` / `Serving`** —
  the runtime contract. All parameterised by port **classes**
  (`Needs extends AnyPort`) but handing out `Context<InstanceType<Needs>>`,
  because di parameterises `Context<in R>` by port **instance** types.
  `Serving.drain(signal)` returns `AsyncResult<void, never>` — **not** a
  `DrainReport`: only the kernel can see the unit registry, so the kernel owns
  the accounting. `drain` means "stop accepting"; the `AbortSignal` fires when
  the kernel's deadline passes, so a runtime never does arithmetic on time.
- **`RuntimeStartFailed`** — the one error the kernel mints, a `TaggedError`
  carrying `{ runtime, cause }`. A probe bind failure uses
  `runtime: "probes"`.
- **`UnitMeta` / `UnitWork` / `UnitRegistry`** — `UnitMeta` is
  `{ kind, id, traceId?, tenantId?, deadline? }`; `traceId` defaults to `id`.
  `UnitWork` may return an `AsyncResult`, a `Promise<Result>` or a plain
  `Result` — the `Promise` arm is Thesis #6's second exception, since it exists
  to accept a caller's `async` handler. `UnitRegistry.awaitIdle()` returns
  `AsyncResult<void, never>`.
- **`currentUnit()` → `UnitRecord | undefined`** — the ambient read. `undefined`
  outside a unit.
- **`Clock` / `systemClock`** — `{ now, sleep(ms, signal?) }`, where `sleep`
  returns `AsyncResult<void, never>`. It takes an `AbortSignal` because a second
  signal must cut the pre-drain delay short, and `systemClock` `unref`s its
  timer so a shutdown sleep is never the reason the event loop stays alive.
- **`Phase`** — `"building" | "starting" | "serving" | "draining" | "stopping" | "exited"`.
- **`KernelEvent` / `EventSink` / `stderrSink`** — eight events: `building`,
  `serving`, `draining`, `drained`, `stopping`, `exited`, `teardownError`,
  `uncaught`. `stderrSink` writes one JSON line per event.
- **`runMain(app, exit?)`** — awaits `exited` and sets the exit code:
  `0` clean (or drained with nothing abandoned), `1` a modeled startup `Err`,
  `2` drained with work abandoned, `70` an uncaught exception/rejection, `70` a
  defect. Both `70`s are sysexits(3)'s `EX_SOFTWARE`. **A crash outranks
  abandoned work** — written out explicitly rather than left to depend on the
  fact that the uncaught path skips the drain anyway.
- **`VERSION`**.

There is **no** `Defect` construction, no `overrideProvider`, no accumulation of
runtimes, and no `recoverFailure`-style channel-moving helper. Swapping an
adapter is composing a different module, which di already documents and the type
checker already verifies.

### `@btravstack/start/testing`

- **`testRuntime(name?)`** — an in-memory `Runtime<never>` plus `started()`,
  `untilStarted()` (an `AsyncResult<void, never>`), `accepting()`, `serving()`,
  `submit<T, E>()`. `submit`
  returns a `SubmittedUnit` (`settle`, `result`, `signal`) so a test can hold a
  unit open across a drain. It deliberately **ignores** the
  `Serving.drain(signal)` deadline, which is what makes the abort tests tests of
  the kernel.
- **`createFakeClock(start?)`** — a `Clock` whose time moves only on
  `advance(ms)` (an `AsyncResult<void, never>`), which brackets itself with a
  real macrotask at each end so a test can trigger a shutdown and advance in the
  very next statement without racing the kernel arming its next sleep.
- **`withApp(module, options, use)`** — start, hand to `use`, stop again
  whatever `use` does. `signals` and `probes` are **forced off** whatever the
  caller passes; a test needing the real probe server calls `start` directly.
  It carries the same phantom gate as `start`, and is the one harness-shaped
  exception to Thesis #6 (both it and `use` speak a bare `Promise`).

## Internal design (don't break these)

Source layout (`packages/start/src/`), one concept per file: `ambient.ts`
(`AsyncLocalStorage`), `clock.ts`, `deferred.ts`, `drain-report.ts`, `drain.ts`,
`events.ts`, `fake-clock.ts`, `phase.ts`, `probes.ts`, `run-main.ts`,
`runtime.ts`, `signals.ts`, `start.ts`, `test-runtime.ts`, `uncaught.ts`,
`units.ts`, `with-app.ts`, plus `index.ts` / `testing.ts`.

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

## Toolchain & conventions

- **Runtime dependencies: none.** `unthrown` and `@btravstack/di` are **peer**
  dependencies — the dual-copy hazard is real for both (di's port identity and
  unthrown's `isResult` each compare across copies). `node:` builtins only
  otherwise. Do not add a dependency.
- `engines: { node: ">=20" }` on the published package; `files: ["dist"]`;
  `sideEffects: false`; dual CJS/ESM via tsdown; `declarationMap: false` (the
  published tarball has no `src/`, so maps would be dead ends).
- TypeScript `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`;
  ESM-first; `moduleResolution: NodeNext` — relative imports carry `.js`.
- **oxlint rules are binding: no `interface` (use `type`), no `any` (use
  `unknown`).** Genuine exceptions carry a targeted `oxlint-disable` **with a
  reason**. Two are structural: `units.ts`'s `UnitWork` return union
  (`prefer-async-result`, a function-type return position) and `run-main.ts`'s
  `P._` (`no-catch-all-pattern`, the generic-`E` case where the catch-all is
  the only arm that can terminate the match).
- The repo dogfoods **every** `@unthrown/oxlint` rule — the five `recommended`
  ones plus all three opt-ins (`no-throw`, `prefer-ensure`, `no-get-or-throw`).
  So a `throw` is a lint error everywhere, spec files included: the six that
  survive each carry an `oxlint-disable-next-line unthrown/no-throw` naming
  why. They fall into two kinds — a **loud test fixture** whose failure means
  the _test_ is buggy (`test-runtime.ts`'s two misuse guards, `invariants.spec.ts`'s
  `boundPort`), and a throw that **is the subject under test**
  (`events.spec.ts`'s throwing sink, `units.spec.ts`'s throwing unit,
  `run-main.spec.ts`'s defect, which has no public constructor to mint it any
  other way). `no-get-or-throw` is switched off for the `*.spec.ts` glob through
  an `overrides` entry — the exemption the rule's own diagnostic prescribes,
  since `getOrThrow()` is the right tool in a test; it stays on everywhere
  else, where nothing uses it. An unused `oxlint-disable` is itself a warning,
  so do not add one pre-emptively.
- **Pre-lifted constructors, not `.toAsync()` on a fresh literal.** `OkAsync(v)`
  / `ErrAsync(e)` / `OkAsync()` are what unthrown ships for this;
  `Ok(v).toAsync()` and `Ok(undefined)` are the boilerplate they replace.
  `.toAsync()` survives only where it lifts a `Result` that already exists —
  `examples/order-application`'s `placeOrder(id, quantity).toAsync()` is the one
  such site.
- Comment density: **sparse**. No comments in JSON files. Rationale belongs
  here, not inline — except where a comment is guarding a specific line against
  a plausible "simplification" (the `teardownErrors` aliasing, the `ready()`
  latch, the monotonic `completed`), which is what the surviving comments are.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Coverage thresholds are 100% lines/functions on `packages/start`, with
  `testing.ts` excluded (it is a re-export barrel).
- **Test conventions.** `@unthrown/vitest`'s matchers are registered via
  `setupFiles` (`toBeOk`, `toBeOkWith`, `toBeErrTagged`, …). Timing is asserted
  through `createFakeClock`, never a real `setTimeout` — a kernel whose own
  tests are slow gets tested badly. `*.test-d.ts` files are excluded from the
  build, from oxlint and from knip; they are checked by `tsc -p
tsconfig.test-d.json`, which `pnpm typecheck` runs.
- Documentation drifts silently, and a sibling repo has already shipped a
  falsehood this way. When the public surface changes, update `CLAUDE.md`, both
  READMEs **and** `docs-examples.test-d.ts` in the same commit.

## Status

Shipped: the whole kernel — phase tracker, injectable clock, ambient record,
unit registry, `Runtime` contract, `start`, draining, signals, uncaught
handling, probes, `runMain`, the testing entry point, and the invariants suite.

Deferred, deliberately:

- `@btravstack/start-http`, `-amqp`, `-temporal` — the runtime implementations.
  **They do not exist**; the `Runtime` contract is the whole of what this
  package owes them. Do not write as though they ship.
- The `@btravstack/oxlint` rule banning `currentUnit()` outside infrastructure
  adapters (Thesis #2) — it needs a way to identify an adapter.
- Per-unit ports: the `unit` module wired into `run`'s fork. `RunUnit` is typed
  for it; the `Module.forkScope` call lands when the first runtime needs a
  per-request transaction.
