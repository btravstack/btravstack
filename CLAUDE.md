# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository. It is the authoritative spec — the rules _and_ the
reasoning behind them. Keep it in sync with the code as the package evolves
(describe what _is_, not what was planned).

## What this is

`@btravstack/start` — the application kernel. It boots a `@btravstack/di`
module into a running process with one runtime, drains in-flight work on
SIGTERM, and closes the application scope on every path. It owns three
things — the lifecycle state machine, the unit-of-work registry, and the
`Runtime` contract — and knows nothing about HTTP, AMQP or Temporal.

`di` proves the wiring before the process exists. `start` owns **when** an
already-proven graph is constructed and torn down, and nothing more. Nothing
throws to callers: every fallible operation returns an
[`unthrown`](https://github.com/btravstack/unthrown) `Result`.

pnpm workspace + turbo monorepo. `packages/` holds five published packages:
`di` (the module-based DI container the kernel boots — merged in from the
former `btravstack/di` repo, history included; still published as
`@btravstack/di` and still a **peer** of the other four), `start` (the
kernel), `start-http` (the HTTP runtime), `start-temporal` (the Temporal
worker runtime) and `start-amqp` (the AMQP consumer runtime).
`examples/` holds fourteen private ones — a clean-architecture application
(`order-domain` → `order-application` → `order-infrastructure`) booted under
four different runtimes (`order-api`, `order-worker`, `order-temporal`,
`order-amqp`), with each transport's contract in a package of its own
(`order-api-contract`, `order-temporal-contract`, `order-amqp-contract`)
because a client must be able to take a contract without the server, plus
di's three consumer examples (`hexagonal-order-api`, `request-scope`,
`plugin-registry`). They are consumers, not fixtures: they are part of the
gate, and `examples/README.md` is their index. `docs/` is the VitePress +
TypeDoc site for `packages/di` (deployed by `deploy-docs.yml`).

## Commands

The gate — every change must keep all six green, and CI runs the same set:

```sh
pnpm format --check   # oxfmt (run without --check to auto-fix)
pnpm lint             # oxlint, incl. all eight @unthrown/oxlint rules
pnpm typecheck        # tsc, incl. the type-level *.test-d.ts files
pnpm knip             # dead code / unused deps
pnpm test             # vitest + v8 coverage (100% lines/functions, enforced)
pnpm build            # tsdown dual CJS/ESM + d.ts
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
   `examples/order-api`, `examples/order-worker` and `examples/order-temporal`
   make this testable rather than asserted: the same `ApplicationModule` +
   `PersistenceModule` composition under three runtimes, with the same
   `DuplicateOrder` arriving as a typed `CONFLICT` on the first, a dead-letter
   on the second and a `nonRetryable` typed contract error on the third — and
   no mapping anywhere near the kernel. The third is also where
   `Serving.drain` first meets a transport with real drain semantics of its
   own — which is why that half now lives in `@btravstack/start-temporal`, the
   package the example consumes: `worker.shutdown()` stops polling immediately and `run()` resolves only
   once the in-flight activity has finished, so `drain` is a genuine wait
   rather than the "stop accepting, nothing left to await" the other two are.
   It is also the first runtime that has to **honour** the deadline
   `AbortSignal` rather than merely note it: `run()` settles on Temporal's own
   `shutdownForceTime`, so an activity that never finishes would hold
   `Serving.stop` well past the kernel's `drainTimeoutMs` unless the signal is
   raced against it — and `@temporalio/worker` exposes no public forced
   shutdown to escalate to, so "stop waiting" is the escalation.

2. **Ambient carries DATA. The DI `Context` carries CAPABILITIES.** The kernel
   opens one `AsyncLocalStorage` store per unit holding a small, fixed record —
   `{ unitId, traceId, tenantId, deadline }` (`UnitRecord` in `units.ts`) —
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
   belongs to the handler an application hands `@btravstack/start-http`
   (oRPC, Hono, a bare function) — the package itself declines that mapping,
   deliberately — `Result` → activity failure to `-temporal`, likewise. `-amqp`
   declines it too, and more starkly: `Result` → ack/nack/DLQ is a **three-way**
   split between `amqp-contract`'s own dispatch and the handler, not something
   either package owns outright. A modeled `RetryableError`/`NonRetryableError`
   is routed by the library against the queue's `retry` config; a `Defect` is
   **not** — it is nacked once, immediately, straight to the dead-letter queue,
   never touching that budget — so a handler that wants "infrastructure comes
   back" has to recover its own `Defect`s into a `RetryableError` explicitly, or
   an infrastructure failure is parked on the first attempt exactly like a
   permanent domain error. The claim that survives across all three transports
   is only that the _kernel_ maps nothing; what each transport's own mapping
   looks like is the transport's own business, sometimes split further still.
   `RunUnit` is
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
   `runtimeInfo()`, `Clock.sleep`, `FakeClock.advance`, `UnitRegistry.awaitIdle`,
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

## Kernel internals

Two sections live in `packages/start/CLAUDE.md`, which loads only when you work
under that directory: **Load-bearing runtime invariants (tests must guard
these)** — each invariant with the test that guards it — and **Internal design
(don't break these)**. Read them before changing anything in
`packages/start/src/`, and update them in the same commit as the code.

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

## Two contracts a runtime owes, and neither is checkable

Both surfaced from building the first real runtime against this kernel, and
both are silent when broken. They live in the `RunUnit` / `RuntimeHost` /
`UnitMeta` TSDoc, in the root README's _"Two contracts a runtime owes"_ and in
the package README's _"Writing a runtime"_ — four places that must stay in
sync.

**1. The response must be flushed INSIDE the unit.** A unit is closed the
instant its `Result` settles; `registry.awaitIdle()` is what beat 3 of the
drain races, and an idle registry is the kernel's permission to move on to
`Serving.stop()`. A runtime that resolves the unit and _then_ writes to its
client is racing `stop()` tearing the transport down — with a small body the
write usually wins, with a large one it does not (proved with an 8 MB body:
`UND_ERR_SOCKET: other side closed`). A unit is not "compute the answer", it is
"compute the answer **and get it out of the process**". The kernel cannot
enforce this: it sees a settled `Result`, and has no idea whether bytes are
still in flight.

**2. `UnitMeta.id` must be unique per unit, unless a `traceId` is supplied.**
`traceId` defaults to `meta.id`, so a runtime passing a _category_ as the id —
an HTTP runtime using the route template `"POST /orders"` — gives every request
the same trace id, and the ambient record's whole purpose is silently defeated.
`traceId` stays **optional** deliberately: `meta.id` genuinely IS a correct
trace id whenever it is already unique per unit (a queue job id, a broker
message id), which is the common case, and the kernel could not verify a
required one either — it would have to remember every id ever seen, so the
obligation would be syntactic, not checked, and `traceId: routeTemplate` would
type just as well as the bug it replaces. The defect was the unstated contract,
not the default. Note `UnitRecord.unitId` is minted per unit and always unique,
so telling two units apart never needs `traceId`; `traceId` is the
**correlation** id, which is why it is the one a runtime may supply — it
carries an id from outside the process so a line logged here joins a trace that
started elsewhere.

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
- **`StartOptions<Needs, Info>`** — `runtime` (required); `clock`
  (default `systemClock`); `signals` (default `true`; **`false` disables the
  SIGTERM/SIGINT handlers _and_ the uncaught ones together**); `probes`
  (default `{ port: 9000 }`, or `false`); `preDrainDelayMs` (`5_000`);
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
- **`Runtime<Needs, Info>` / `RuntimeHost<Needs>` / `RunUnit<Needs>` /
  `Serving<Info>`** — the runtime contract. All parameterised by port **classes**
  (`Needs extends AnyPort`) but handing out `Context<InstanceType<Needs>>`,
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
- **`currentUnit()` → `UnitRecord | undefined`** — the ambient read. `undefined`
  outside a unit.
- **`Clock` / `systemClock`** — `{ now, sleep(ms, signal?) }`, where `sleep`
  returns `AsyncResult<void, never>`. It takes an `AbortSignal` because a second
  signal must cut the pre-drain delay short, and `systemClock` `unref`s its
  timer so a shutdown sleep is never the reason the event loop stays alive.
- **`Phase`** — `"building" | "starting" | "serving" | "draining" | "stopping" | "exited"`.
- **`KernelEvent` / `EventSink` / `stderrSink`** — eight events: `building`,
  `serving`, `draining`, `drained`, `stopping`, `exited`, `teardownError`,
  `uncaught`. `stderrSink` writes one JSON line per event, normalising an
  `Error` cause to `{ name, message, stack, cause }` — `JSON.stringify` skips
  non-enumerable properties, so a bare one renders the two cause-carrying
  events as `{"cause":{}}`. A cause it cannot serialise at all (a circular
  object) falls back to `"[unserialisable]"` rather than throwing, since
  `safeSink` would swallow the throw and the event would be reported nowhere.
- **`runMain(app, exit?)`** — awaits `exited` and sets the exit code:
  `0` clean, `1` a modeled startup `Err`, `2` drained with work abandoned **or
  exited with a non-empty `teardownErrors`**, `70` an uncaught
  exception/rejection, `70` a defect. Both `70`s are sysexits(3)'s
  `EX_SOFTWARE`. **A crash outranks abandoned work** — written out explicitly
  rather than left to depend on the fact that the uncaught path skips the drain
  anyway. `2` means "we stopped, but not cleanly", and a failed finaliser earns
  it as much as abandoned work does: the kernel goes to real trouble to keep
  those errors observable (the `teardownErrors` aliasing), which reporting `0`
  over them would waste.

There is **no** `Defect` construction, no `overrideProvider`, no accumulation of
runtimes, and no `recoverFailure`-style channel-moving helper. Swapping an
adapter is composing a different module, which di already documents and the type
checker already verifies.

### `@btravstack/start/testing`

- **`testRuntime(name?)`** — an in-memory `Runtime<never, TestRuntimeInfo>` plus
  `started()`, `untilStarted()` (an `AsyncResult<void, never>`), `accepting()`,
  `serving()`, `submit<T, E>()`. It publishes `{ name }` on `Serving.info` — the
  one thing an in-memory runtime genuinely knows about itself — so the
  `runtimeInfo()` channel is exercised end to end by the suite. `submit`
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
  exception to Thesis #6 (both it and `use` speak a bare `Promise`). It
  **rethrows a `Defect`** on `exited` and only a `Defect`: the harness awaits
  `exited` to know the application stopped, and dropping that `Result` let a
  shutdown that blew up pass as a green test when `use` never read `exited`. A
  modeled `Err` is an outcome a test may be asserting, so it passes through. A
  failure thrown by `use` outranks both — it is held while the application is
  stopped and rethrown unchanged, so a shutdown defect can never mask the
  assertion that actually failed.

### `@btravstack/start-http`, `@btravstack/start-temporal` and `@btravstack/start-amqp`

Their public surfaces live in `packages/start-http/CLAUDE.md`,
`packages/start-temporal/CLAUDE.md` and `packages/start-amqp/CLAUDE.md`, which
load only when you work under those directories — the same split
`packages/start/CLAUDE.md` already uses for the kernel's internals. Read the
one you are changing before you change it, and update it in the same commit as
the code.

## Toolchain & conventions

- **`examples/` is part of the gate, not a folder of illustrations.** All
  eleven workspaces run under the same six commands as the kernel — 93 specs
  plus five `needs-gate.test-d.ts` files and four `layering.test-d.ts` ones —
  so an example that stops compiling, stops linting or stops passing fails CI
  exactly as `packages/start` would. Four of the five needs-gate files pin
  **`start`'s** runtime-needs gate (`order-api`, `order-worker`,
  `order-temporal`, `order-amqp`); the fifth, `order-application`'s, pins
  **di's** `UNSATISFIED DEPENDENCIES` gate on `Module.scoped`. They are
  different gates and easy to conflate.
  A runtime with a **non-empty `needs`** meeting a real module now exercises
  `start`'s phantom rest-tuple gate and `RuntimeHost`'s
  `Context<InstanceType<Needs>>` in two places: here, and in
  `packages/start-http/src/test-fixtures.ts`'s `Greeting` port / `AppModule`,
  driven by its 12 `http-runtime.spec.ts` specs. `examples/` stays the only
  place the gate is pinned by a **type test** — `start-http` ships no
  `*.test-d.ts`.
- **`examples/order-temporal` is the one workspace whose suite needs the
  network, and only on a cold cache.** It runs a real `@temporalio/worker`
  Worker against `@temporalio/testing`'s **time-skipping test server** — a
  64 MB local binary, not a container — so the whole Workflow-Task /
  Activity-Task loop is exercised without starting one. A container would be
  allowed (see the integration-test rule below); this is simply cheaper and
  faster for the same coverage. The binary is fetched once,
  keyed by the `@temporalio` SDK version, into
  **`<repo>/.cache/temporal-test-server`** (gitignored) with **`ttl: "365d"`,
  set in `src/test-fixtures.ts`. Both are deliberate: the SDK's defaults are
  the OS temp directory — which CI wipes between jobs and macOS purges on its
  own schedule — and a one-day ttl, so a developer running the suite twice in a
  week downloads it twice. A cold cache with no network fails loudly at
  `createTimeSkipping()`, naming the URL. Measured with no container running: **7.4 s
  cold** (download included), **3.8–3.9 s warm** — the slowest package in the
  repo and still under four seconds. **CI does not yet cache that directory**:
  `.github/workflows/ci.yml` delegates wholly to
  `btravstack/config`'s `ci-reusable.yml@workflows-v1`, and a caller cannot
  inject an `actions/cache` step into a reusable workflow's jobs. Closing it
  means adding a cache-path input there, not here; until then every test job
  pays the ~3.5 s download.
- **`packages/start-amqp` and `examples/order-amqp` are the two workspaces
  whose suites need a Docker daemon**, per the integration-test rule below.
  `@amqp-contract/testing` boots one real RabbitMQ container per vitest run
  (`globalSetup`) — the retry/dead-letter routing this package leans on is the
  broker's own behaviour, not something an in-memory fake or a local binary
  could stand in for. Measured on this machine: `packages/start-amqp`
  **17.6 s cold** (image pull included), **7.3–8.0 s warm**; `examples/order-amqp`
  **15.5 s cold**, **4.8–5.6 s warm** — both slower than `order-temporal`'s
  network-cache case, and cold only on a machine that has never pulled
  `rabbitmq:4.2.1-management-alpine` before.
- **The Prisma client is generated at test time, and there is nothing to
  install.** `@btravstack/start-example-order-infrastructure`'s `generate`
  script writes a gitignored client into `src/generated`, and turbo's `test` /
  `typecheck` / `test:types` tasks carry **both** a `generate` and a
  `^generate` edge — the first so the workspace's own client exists, the second
  so a dependent workspace gets one too. The scripts themselves do **not** call
  `prisma generate`: they did until 2026-08-13, and on a cold cache turbo ran
  the `generate` task and the script's inline copy **concurrently**, which
  fails with `EEXIST: mkdir …/generated/prisma/models`. One generator, ordered
  by the task graph, is what makes that impossible rather than rare. The
  database is SQLite **in memory** with the schema applied by hand, because it
  is faster and simpler than a container for a repository test — not because a
  container was forbidden. See the integration-test rule below.
- **An integration test may boot its real dependency with Docker and
  testcontainers.** A suite that needs a broker, a database or a service starts
  one; there is no rule against a daemon, and a hand-written double that fakes
  the thing under test would prove less than the container does. What is still
  true is the preference underneath: reach for the cheapest fixture that tests
  the real behaviour — in memory when the behaviour is the library's (SQLite for
  a repository), a local binary when one exists (Temporal's time-skipping
  server), a container when neither does (a broker). State the cost in the
  workspace's README, since a suite that needs a daemon is a fact a contributor
  discovers the hard way otherwise.
- **`examples/order-temporal` consumes `@btravstack/start-temporal`**, the same
  way `order-api` consumes `-http`: it supplies the contract, the two ports its
  activity resolves and the `mapErrCases` triage, and reads `{ taskQueue,
namespace }` back off `Serving.info`. The Worker's lifecycle, the unit per
  attempt and the deadline race are the package's. It is the second place the
  package's needs gate is a real one.
- **`examples/order-api` consumes `@btravstack/start-http` rather than
  hand-rolling a transport.** It supplies only `apiHandler` — the per-request
  `Module.forkScope` and the oRPC router — and reads `port` back off
  `Serving.info`; binding, the drain and the trace-id policy are the package's.
  This is what makes the package's needs gate a real one: `httpRuntime<Needs>`
  infers `Needs` from the `needs` array the same way a hand-rolled runtime did.
- **oRPC is pinned to an exact beta.** `@orpc/{client,contract,server}` sit at
  `2.0.0-beta.23` in the catalog because oRPC v2's `latest` dist-tag is still
  the **1.x** line, while `@unthrown/orpc` peers on `^2.0.0-beta`: an unpinned
  range resolves 1.x and fails `strictPeerDependencies`. The exact beta is the
  contract until v2 goes stable; raise it deliberately, not on a bot bump.
- **`temporal-contract` is pinned to an exact beta, for the same shape of
  reason.** `@temporal-contract/{client,contract,testing,worker}` sit at
  `8.0.0-beta.5` because the `latest` dist-tag is the **7.x** line, which peers
  on `unthrown@^4` while this repo pins 5.2.0 — and 7.x ships neither the
  `test-rig` nor the `workflow-bundle` subpath the Temporal example's specs are
  built on. `testcontainers` is an **optional** peer of
  `@temporal-contract/testing` and is not installed, because the time-skipping
  server is what that example uses — not because containers are unwelcome.
- **Runtime dependencies: none.** `unthrown` and `@btravstack/di` are **peer**
  dependencies of `start` — the dual-copy hazard is real for both (di's port
  identity and unthrown's `isResult` each compare across copies). `start-http`
  peers on both of those plus `@btravstack/start` itself, for the same reason.
  `node:` builtins only otherwise. Do not add a dependency. di living in this
  repo changes none of that: the kernel packages reference it as
  `workspace:^` in devDependencies, and the published peer range stays
  `^0.1.0` — a consumer still installs `@btravstack/di` themselves.
- `declarationMap: false` on all five published packages — the published
  tarball has no `src/`, so maps would be dead ends.
- **Relative imports carry `.js`.** `moduleResolution: NodeNext` plus
  `verbatimModuleSyntax`, both inherited from `@btravstack/tsconfig/base.json` —
  an external package under `node_modules`, so this is the one convention here
  the repo itself cannot show you. `import { x } from "./units"` fails
  `pnpm typecheck` with TS2835.
- All four published packages claim `engines: { node: ">=20" }` while the root
  claims `>=22.19`. The divergence is **deliberate**: the root floor is the dev
  toolchain's, a package's is a compatibility promise to consumers. Do not
  align them for tidiness — raising a published floor is a breaking change.
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
  other way). `no-get-or-throw` is switched off for the `**/*.spec.ts` **and
  `**/test-fixtures.ts`** globs through an `overrides` entry — the exemption the
  rule's own diagnostic prescribes, since `getOrThrow()` is the right tool in a
  test, and a fixture module is test code that merely does not end in
  `.spec.ts` (see Test conventions); it stays on everywhere else, where nothing
  uses it. An unused `oxlint-disable` is itself a warning,
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
- Test mechanics: `@unthrown/vitest`'s matchers are registered via `setupFiles`
  (`toBeOk`, `toBeOkWith`, `toBeErrTagged`, …). Timing is asserted through
  `createFakeClock`, never a real `setTimeout` — a kernel whose own tests are
  slow gets tested badly. `*.test-d.ts` files are excluded from the build, from
  oxlint and from knip; they are checked by `tsc -p tsconfig.test-d.json`, which
  `pnpm typecheck` runs. The structural rules are in **Test conventions** below.
- Documentation drifts silently, and a sibling repo has already shipped a
  falsehood this way. When the public surface changes, update **this** file,
  both READMEs **and** `docs-examples.test-d.ts` in the same commit — and when
  the change is to `packages/start/src/` internals or the invariants guarding
  them, `packages/start/CLAUDE.md` too — and for a runtime package, its own:
  `packages/start-http/CLAUDE.md`, `packages/start-temporal/CLAUDE.md` or
  `packages/start-amqp/CLAUDE.md`, whichever is where that package's public
  surface lives. `packages/di/CLAUDE.md` plays the same role for the DI
  container. There are **six** `CLAUDE.md` files; naming the wrong one is
  how the last drift happened.

## Test conventions

Five rules, each with the reason it exists — binding at two different scopes,
which is a decision rather than an accident.

**Rules 4 and 5 are substantive and bind everywhere**, `packages/start`
included. They are what stops an assertion silently declining to run: a
conditional or optional-chained `expect` skips without failing the test, and a
scatter of shallow assertions hides which one is load-bearing. That shape was
caught three separate times in review, which is why it is a rule and not a
preference.

**Rules 1 to 3 are structural and bind `examples/`**, the teaching surface,
where the shape of a spec is itself read as advice. The kernel's 13 spec files
predate them and are **deliberately not swept**: they are mutation-verified, hold
the package at 100% line and function coverage, and are the tests guarding the
shipped invariants — restructuring them buys consistency while risking exactly
the weakening rules 4 and 5 exist to prevent. A **new or rewritten** kernel spec
follows all five; an untouched one is not churned for it.

That split was measured, not assumed. An audit of the kernel's 93 tests found
**one** conditional assertion — a redundant `isOk()` block re-checking a field
the preceding deep `toBeOkWith` had already pinned exactly, since deleted —
**zero** optional-chained assertions, and 1.77 expects per test against the 2.25
the examples carried before their sweep. The substantive rules were already being
kept; only the structural ones differ.

1. **`describe` is the first statement a reader meets.** After the imports,
   nothing but `describe`. A file that opens with 144 lines of helpers makes a
   reader scroll past the scaffolding to reach the subject, and every one of
   those helpers is invisible state a test silently depends on. What a test needs
   should arrive **through its own parameter list**, so the dependency is written
   down at the point of use.
2. **Helpers are Vitest fixtures, injected via `test.extend`, and they live in a
   sibling `src/test-fixtures.ts`.** The module exports an extended `it`, which
   every spec in that package imports instead of vitest's own. Keeping the
   `test.extend` block out of the spec is what makes rule 1 achievable — the
   fixture bodies are themselves helpers, so leaving them above `describe` only
   renames the problem. A shared module also lets several `describe` blocks (and
   later, several spec files) draw on one set. Fixtures are **lazy**: a test that
   does not name one never builds it, so an expensive fixture costs nothing in
   the tests that ignore it.
   Both `**/*.spec.ts` and `**/test-fixtures.ts` are in the `.oxlintrc.json`
   `overrides` entry that switches `unthrown/no-get-or-throw` off, because a
   fixture is test code and `getOrThrow()` is the right tool there.
3. **Teardown belongs in the fixture, never in `try`/`finally`.** Everything
   after `await use(value)` runs on **every** exit path, including a failing
   assertion — which is precisely what the `finally` blocks were hand-rolling,
   at the cost of a `try` around every test body and one more level of
   indentation around the part that matters. An `expect` in fixture cleanup is
   still a test failure attributed to that test (verified, not assumed), so the
   guarantee a `finally` carried survives the move intact.
4. **Every test body carries `// GIVEN`, `// WHEN`, `// THEN`.** They mark the
   three phases so the assertion is not read as setup and the setup is not read
   as the subject; a test that cannot be split into three is usually testing more
   than one thing. These markers are **exempt from the sparse comment-density
   rule** above — they are structure, not narration.
5. **One deep `expect` per test, asserting once against one resource.** Not a
   scatter of shallow assertions, and never an assertion that can decline to
   run. The failure mode is concrete: `expect(r).toBeErr(); if (r.isErr()) {
expect(r.error.code)… }` passes on the outer assertion alone the moment the
   narrowing is false — every assertion inside silently does not run, and the
   test still goes green. So does `descriptor?.writable`, and so does any
   assertion reached through an `&&` guard. A single deep assertion has no such
   hole: `await expect(call()).toBeErrWith(expect.objectContaining({ code:
"CONFLICT", data: { id } }))` either matches or fails. In practice:
   - Collapse several properties of one resource into one deep assertion, with
     `@unthrown/vitest`'s matchers (`toBeOkWith`, `toBeErrWith`,
     `toBeErrTagged`, `toBeDefectWith`) plus `expect.objectContaining` /
     `expect.any` / `expect.not.stringContaining` where a partial or loose match
     is genuinely wanted. To pin a **class** inside the same assertion, put
     `constructor: TheClass` in the `objectContaining` — asymmetric matchers
     read through the prototype chain, so it is `toBeInstanceOf` without a
     second `expect` (verified: it rejects a structural impostor).
     Where the facts are not properties of one object, assert a **projection**
     of them (`expect({ livez, readyz, ready }).toEqual({ … })`).
   - **Two resources means two tests**, not two assertions. The test count
     rising is the expected outcome.
   - The GIVEN phase asserts nothing. Chain the setup into the subject
     (`repository.save(x).flatMap(() => repository.find(id))`) so a failed setup
     surfaces in the one assertion instead of needing a guard assertion of its
     own — which also keeps the setup's `Result` consumed rather than dropped.
   - Waiting is not asserting: use `vi.waitUntil(() => …)` to synchronise on a
     state, and assert that state in the test's one `expect`. `expect.poll` used
     as a barrier reads as an assertion and is not one.
   - Fixture teardown keeps its own `expect` (rule 3) — that is cleanup, not the
     test's assertion.

A sixth rule is about production code that tests keep honest:

6. **Configuration is validated through a schema and returned as a value, never
   `.parse()`d.** `examples/order-api/src/env.ts` is the shape: a schema over
   `process.env` run through `@unthrown/standard-schema`'s `fromSchema`, whose
   issues are the modeled `E`, folded by the entry point into a message and a
   non-zero exit code. A schema's own `.parse()` **throws**, which
   `unthrown/no-throw` bans and which would contradict the example it appears in.
   A numeric variable is a **non-empty string piped into a coercion** —
   `z.string().trim().min(1).pipe(z.coerce.number<string>().int().min(min).max(max)).default(f)`
   — never a bare `z.coerce.number()`: coercion is `Number()` underneath, so
   `PORT=abc` binds `NaN` and `PORT=` binds the ephemeral port `0` — the exact
   silent failure the module exists to remove. The bounds catch the first (and
   `3.5`, and out-of-range); they cannot catch the second, because a **port's
   `min` is `0`** so that an ephemeral bind stays expressible, which is why the
   string guard is not optional. An empty or whitespace-only value is a
   configuration **error**, not an absent one — `.default(...)` applies only
   when the variable is genuinely missing. The fragment is
   `examples/order-config`'s `wholeNumber` / `port`, shared by all three
   deployments, and its spec pins all seven cases (absent, `""`, whitespace,
   `abc`, `3.5`, valid, out of range) **once**. Each deployment's own `env.ts`
   is then its variables and their defaults, and its own spec pins what is
   genuinely its own — `order-worker`'s `CONCURRENCY` bound differs from a
   port's, and `order-temporal`'s two string variables have an emptiness rule
   of their own. Triplicating the fragment was the earlier shape; it was cut
   in the audit that also deleted this repo's planning documents. The `<string>` type argument
   is needed because `z.coerce.number()`'s input is `unknown`, which `.pipe`
   will not accept from a `string`. The earlier digits-only regex plus
   `.transform(Number)` was the over-built form of this; it was simplified in
   the PR #7 review, and a bare `z.coerce.number()` was tried there and reverted
   for the `min(0)` hole above.
   Note `fromSchema` is **curried** — `fromSchema(schema)(input)`, not
   `fromSchema(schema, input)`.

## Deferred, deliberately

- **Caching the Temporal test-server binary in CI.** The path is stable and
  gitignored; what is missing is the `actions/cache` step, which cannot be
  written from `start`'s `ci.yml` while it delegates to
  `btravstack/config`'s reusable workflow (see Toolchain & conventions). It
  costs ~3.5 s per test job, not correctness.
- The `@btravstack/oxlint` rule banning `currentUnit()` outside infrastructure
  adapters (Thesis #2) — it needs a way to identify an adapter.
- Per-unit ports: the `unit` module wired into `run`'s fork. `RunUnit` is typed
  for it; the `Module.forkScope` call lands when the first runtime needs a
  per-request transaction.
- **A `docs-examples.test-d.ts` for `start-http`, `start-temporal` and
  `start-amqp`.** `packages/start`'s exists precisely so its two READMEs
  cannot drift from `runtime.ts` / `drain-report.ts` without failing `pnpm
typecheck`; the three runtime packages' README samples have no such gate
  and are compiled by nothing. Deliberately not built — three packages' worth
  of samples still did not justify the harness. Add it the next time one of
  those samples is found to have drifted, the same way this gap itself was
  found.
- ~~Bringing `packages/start`'s 13 spec files under the Test conventions.~~
  **Closed by decision, not by doing it.** An audit of the 93 tests found the
  substantive rules (4 and 5) already kept — one conditional assertion, since
  deleted, and zero optional-chained ones — so the sweep would have been
  structural only: GIVEN/WHEN/THEN markers on all 13, a helper preamble to lift
  in 9 (`drain` 82 lines, `invariants` 74, `with-app` 37, `probes` 30,
  `run-main` 28, `test-runtime` 21, `start` 17, `units` 12,
  `process-handlers` 7), and one `try`/`finally` to move. Churning
  mutation-verified tests that hold the package at 100% coverage, for
  consistency alone, risks the very weakening those rules exist to prevent. The
  scope split is recorded in Test conventions above; a new or rewritten kernel
  spec still follows all five.
