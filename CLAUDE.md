# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository. It is the authoritative spec — the rules _and_ the
reasoning behind them. Keep it in sync with the code as the package evolves
(describe what _is_, not what was planned).

## What this is

`@btravstack/core` — the application kernel. It boots a `@btravstack/di` module
into a running
process with one runtime, drains in-flight work on SIGTERM, and closes the
application scope on every path. It owns three things — the lifecycle state
machine, the unit-of-work registry, and the `Runtime` contract — and knows
nothing about HTTP, AMQP or Temporal.

`di` proves the wiring before the process exists. `start` owns **when** an
already-proven graph is constructed and torn down, and nothing more. Nothing
throws to callers: every fallible operation returns an
[`unthrown`](https://github.com/btravstack/unthrown) `Result`.

pnpm workspace + turbo monorepo. `packages/` holds seven published packages,
`di` (the container), `config` (configuration from the environment, as
providers), `core` (the kernel), `testing` (the test harness — `bootFixture`,
`tapped`, the in-memory runtime, the fake clock; peers on `core`), `http`
(the HTTP starter — oRPC), `temporal` (the Temporal starter) and `amqp` (the
AMQP starter). `di` was its own repository until it was merged here
**with its history**; it is the one package that depends on nothing else in
this workspace, and the dependencies run `core` → `config` → `di`, never
back, with `testing` and the three starters on `core`. Its own spec is
`packages/di/CLAUDE.md`; the harness's is `packages/testing/CLAUDE.md`.
`examples/` holds ten private ones — a clean-architecture application
(`order-domain` → `order-application` → `order-infrastructure`) booted under
three runtimes (`order-api`, `order-temporal-worker`, `order-amqp-worker`),
each doing what its transport is for — answering, orchestrating,
broadcasting — with each transport's contract in a package of its own
(`order-api-contract`, `order-temporal-contract`, `order-amqp-contract`)
because a client must be able to take a contract without the server, plus the
container's own `hexagonal-order-api`, which composes a `Module` and never calls
`start`. They are
consumers, not fixtures: they are part of the gate, and `examples/README.md`
is their index. `docs/` is the documentation site (see **Documentation
site** below); it is a workspace but not a published package.

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
   failure takes the process down. The runtime is therefore **one port** —
   every runtime package's port is declared over the kernel's `RuntimePort`, so
   they share one id and a graph can hold exactly one — and no future surface
   should make it plural.
   `examples/order-api`, `examples/order-temporal-worker` and
   `examples/order-amqp-worker`
   make this testable rather than asserted: the same `ApplicationModule` +
   `PersistenceModule` composition under three runtimes, with the same
   `DuplicateOrder` arriving as a typed `CONFLICT` on the first and a
   `nonRetryable` typed contract error on the second — the third is a
   broadcast, where a placement's `Err` never crosses the broker and only the
   committed fact does, relayed from a transactional outbox — and no mapping
   anywhere near the kernel. The second is also where
   `Serving.drain` first meets a transport with real drain semantics of its
   own — which is why that half now lives in `@btravstack/temporal`, the
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
   belongs to the router an application hands `@btravstack/http`
   (oRPC's `.result()` triage) — the package itself declines that mapping,
   deliberately — `Result` → activity failure to `@btravstack/temporal`, likewise. `@btravstack/amqp`
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
   - **`@btravstack/testing`'s `withApp` and its `use` callback** (and
     `bootFixture`, vitest's own `(ctx, use) => Promise<void>` protocol).
     `use` is the test body: a thrown assertion failure inside it must reach
     the test runner, and an `AsyncResult` never rejects — converting either
     side would turn a failing `expect` into a `Defect` a caller can forget
     to unwrap, i.e. a green test that asserted nothing
     (`invariants.spec.ts`'s _"8. start neither throws nor calls
     process.exit"_ is exactly that shape). `A` is the test author's own type
     and carries no error channel, so the wrapper would add no information
     either.

7. **The startup error channel is the application's own, unwrapped.** The kernel
   does **not** wrap a construction failure in a kernel error — that would erase
   the module's modeled error type. `Module.scoped` already reports the module's
   `E`, so `start` returns `AsyncResult<ExitReport, E | RuntimeStartFailed>` and
   the application's own errors pass through still typed. `RuntimeStartFailed`
   is the only error the kernel mints, because it is genuinely the kernel's own
   (a port in use, a broker unreachable, a probe port taken).

## Kernel internals

Two sections live in `packages/core/CLAUDE.md`, which loads only when you work
under that directory: **Load-bearing runtime invariants (tests must guard
these)** — each invariant with the test that guards it — and **Internal design
(don't break these)**. Read them before changing anything in
`packages/core/src/`, and update them in the same commit as the code.

The container's internals are in `packages/di/CLAUDE.md`, on the same terms.
Read it before changing anything in `packages/di/src/` — its comments are
regression guards measured against a specific TypeScript version, and it is the
one package here whose type-level behaviour is the product.

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
`UnitMeta` TSDoc, in the documentation site's
`docs/how-to/write-a-runtime.md` and `docs/reference/core/runtime.md` — four
places that must stay in sync. A third, smaller one arrived with
`StartOptions.unit` and lives in the same four places.

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

**3. `RuntimeHost.ctx` is the application context, and unit work is not
synchronous with `host.run`.** Two consequences of `StartOptions.unit`. A port
the unit module provides exists only while a unit is open and reaches the
runtime through `run`'s work callback alone — `start`'s gate lets a runtime's
`needs` name such a port, because unit work is what receives it, so
`host.ctx.get(...)` of one **type-checks** and is a defect at startup; resolve
at `start` only what the application module itself exports. And with a unit
module the work runs only once the fork is built — after an `await` when a
unit provider is async — so a runtime that subscribes to an event from inside
its work (a response's `'close'`) must first check whether it already fired:
`@btravstack/http`'s `closedOf` checks `response.closed` for exactly this,
found by a client hanging up during a slow per-request acquire and leaving a
unit open for the process lifetime.

## Public surface

`packages/core/src/index.ts` is the one place the kernel's API is decided —
one entry point. The test doubles are `@btravstack/testing`, a package of its
own that peers on the kernel (the `@nestjs/testing` shape), so a production
bundle never pulls the fakes in and the kernel ships none; its surface is
below and in `packages/testing/CLAUDE.md`.

### `@btravstack/core`

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
  else. Followed by the phantom `...gate` rest tuple, `StartGate<X,
UnitNeeds>`: `NO RUNTIME` when the module exports no runtime port,
  `UNSATISFIED RUNTIME NEEDS` when the runtime's declared needs are not among
  the module's exports (the module's alone — a unit-only port exists only
  while a unit is open, and `RuntimeHost.ctx` is the application context),
  `UNSATISFIED UNIT NEEDS` for the fork's own direction — all three at the
  call site, on arity.
- **`RuntimePort`** — `Port("Runtime")`, exported **generic** (no fixed
  service): a runtime package declares its own concrete port over it —
  `class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}`
  — so every runtime is one id at runtime while each carries its own
  `Needs`/`Info` in the type. `RuntimeOf<X>` / `RuntimeNeedsOf<X>` /
  `RuntimeInfoOf<X>` read those back out of a module's exports (only
  `RuntimeInfoOf` is exported — the other two are the gate's internals);
  `RuntimeInstance` is the shared instance type
  (`InstanceType<PortClass<"Runtime">>`, internal too). Every
  runtime package ships its port and a starter — `HttpRuntime`/`http()`,
  `TemporalRuntime`/`temporal()`, `AmqpRuntime`/`amqp()` — and none of them
  has `needs` any more: each takes the application's router / activities /
  handlers as a **port its runtime provider depends on** through di — the
  starter's own fixed port (`HttpRouterPort`, `TemporalActivitiesPort`,
  `AmqpHandlersPort`, one id each; the temporal and amqp ones typed per
  contract at the type level, the same generic-value move `RuntimePort`
  itself makes), which the application provides and never names — so their
  `Needs` is `never` and `RuntimeHost.ctx` goes unread by every shipped
  runtime. The kernel keeps `Runtime.needs`, `RunUnit`'s typed `ctx` and the
  `UNSATISFIED RUNTIME NEEDS` arm as the general contract (`testRuntime` and a
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
  both directions at the call site: runtime `needs` may draw on `UnitX`, and
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
- **`Runtime<Needs, Info>` / `RuntimeHost<Needs>` / `RunUnit<Needs>` /
  `Serving<Info>`** — the runtime contract (the _service_ behind a runtime
  port). All parameterised by port **classes**
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

### `@btravstack/config`

Configuration, the twelve-factor way, in a package of its own because it is
its own concern — the kernel's thesis says it owns three things — and because
a starter binds _its_ slice against this package, not the lifecycle machine.
It depends on `di` and `unthrown` only (peers); `core` peers on it, provides
`Env` and binds `PROBE_PORT` through it, and maps `ConfigInvalid` to `78`.
Its own spec is `packages/config/CLAUDE.md`.

- **`Env`** — the environment as a port (`Readonly<Record<string, string |
undefined>>`), provided by `start` to every graph it boots the same way it
  discharges `Scope`, so `start` takes `Module<X, E, Scope | Env>` and nothing
  in an application reaches for `process.env`.
- **`Config.string` / `integer` / `port` `(variable, { default?,
min?, max? })`** — `ConfigField<T>`s (`{ variable, parse(raw) → Result<T,
ConfigFieldInvalid> }`). **`Config.object({...})`** composes them into a
  Standard Schema over the environment (hand-rolled, so the package depends on
  nothing — `ConfigSchema` is the structural slice of Standard Schema v1, and a
  `zod`/`valibot`/`arktype` schema is accepted where it is); every field is
  read so one validation names every offending variable at once.
  **`Config.provider(Port)(schema)`** — or `Config.provider("Name")(schema)`,
  which mints the port and hands it back typed on the provider
  (`provider.port`), the shape for a slice that is one application's own —
  is a di provider with dep `[Env]` whose
  `make` validates and answers **`ConfigInvalid`** (`{ port, issues }`, message
  one line per variable). Modelled on Effect's `Config` (typed descriptions,
  an environment provider swappable for a test) and Spring Boot's
  externalised configuration (a starter binds its own slice: `@btravstack/http`
  → `HttpConfig` from `PORT`/`HOST`), applied to di: a config slice is just a
  port. Precedence, wherever a starter takes options, is explicit > env >
  default, per field.

### `@btravstack/testing`

The test harness, `@nestjs/testing`'s shape: a separate package peering on
`@btravstack/core`, `@btravstack/config`, `@btravstack/di` and `unthrown` — and
**not** on `vitest`. Its own spec is `packages/testing/CLAUDE.md`.

- **`bootFixture(defaults?)`** — a `test.extend` fixture, a plain `async ({},
use) => Promise<void>` (vitest's fixture protocol, hence no vitest import or
  peer) handing the test a **`Boot`**: `start`'s signature and phantom
  `StartGate` minus `signals`. Defaults, a call's own options winning:
  `signals: false` always, `probes: false` unless a call passes one (`{ port:
0 }` binds an ephemeral one), `preDrainDelayMs: 0`, a silent `onEvent`;
  `defaults` (`BootDefaults`, `StartOptions` minus `signals`/`unit`) sits
  between. Every app it started is stopped when the test ends, on every exit
  path; teardown mirrors `withApp` and is **Defect-only** — a `Defect` on
  `exited` fails the test even when the test never read it, a modeled `Err`
  passes through, since a startup failure is an outcome a test may be
  asserting. This is why the examples never used `withApp`: the Test
  conventions mandate `test.extend` fixtures with teardown in the fixture, and
  a callback harness cannot be handed to `use()`, so every suite hand-rolled
  the same `start(...)` + `stop(); expect(exited).toBeOk()` — now the
  package's, and every starter's and example's `test-fixtures.ts` has a
  `boot: bootFixture(...)` its `serve` fixtures build on.
- **`tapped(module, ports)`** → `{ module, services() }` (`ServicesOf<P>`).
  `start` hands the application context to the runtime alone, so a test that
  wants the very `Logger` the use cases write to has no `ctx.get`; `tapped`
  composes one more provider (`Tap`, `Port("@btravstack/testing/Tap")`
  declared once and never exported — two taps in one graph are di's
  duplicate-provider defect, and one per application is the case; the id is
  namespaced because the port is invisible to the application that would
  collide with it) around `module`, depending on `ports`,
  and remembers what it was built with. The returned module exports exactly
  what `module` exports, so the kernel still finds the runtime. **The gate**
  refuses a port `module` does not export (`"NOT EXPORTED"`, at the call
  site); **`services()` throws** before the graph is built — reading a tap
  nobody booted is a bug in the test, not an `undefined` an assertion could
  swallow. What `order-api`, `order-temporal-worker` and `order-amqp-worker`
  hand-rolled as `LoggerTap` / `ServicesTap` providers.
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
- **`testRuntime(name?)`** — an in-memory `Runtime<never, TestRuntimeInfo>` plus
  `started()`, `untilStarted()` (an `AsyncResult<void, never>`), `accepting()`,
  `serving()`, `submit<T, E>()`, and **`module`** — a `Module<TestRuntimePort,
never, never>` providing the runtime on **`TestRuntimePort`** (its port,
  declared over `RuntimePort`, exported too), which is how a test composition
  gets a runtime: import `runtime.module`, export `TestRuntimePort`. It
  publishes `{ name }` on `Serving.info` — the
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

### `@btravstack/http`, `@btravstack/temporal` and `@btravstack/amqp`

Their public surfaces live in `packages/http/CLAUDE.md`,
`packages/temporal/CLAUDE.md` and
`packages/amqp/CLAUDE.md`, which load only when you work under those
directories — the same split `packages/core/CLAUDE.md` already uses for the
kernel's internals. Read the one you are changing before you change it, and
update it in the same commit as the code.

**Starters.** All three are, in the Spring Boot sense: a module that brings
the default behaviour for the standard case, opinionated about the one way it
is done and configurable where a deployment differs. Each ships a **module
sugar** — `HttpModule(name)({ router, imports, provides, exports })`,
`TemporalModule(name)({ contract, activities, workflows, … })`,
`AmqpModule(name)({ contract, handlers, … })` — a `Module(name)({...})` that
also takes the starter's own fields, appends the starter to `imports`,
prepends the router/activities/handlers **provider** to `provides` and the
runtime port to `exports`, and hands those tuples to di's own `Module(name)`
— whose return type is the sugar's, spelled once (see
`packages/di/CLAUDE.md`) — so the kernel and both gates see nothing new; the
plain starter (`http()`, `temporal({ contract, workflows })`, `amqp({
contract })`) stays exported as the primitive it
delegates to, and each **needs** its router / activities / handlers port
rather than taking it as an option. And each ships the **provider sugar** for
what the application supplies — `HttpRouter(contract)(deps, { sync })`,
`TemporalActivities(contract)(deps, arm)`, `AmqpHandlers(contract)(deps,
arm)` — the first call fixing the contract and returning di's own
`Provider(port)` on the starter's **fixed** port, so the second call is
`Provider(port)(deps, arm)` exactly as everywhere else and the provider
carries its port typed (`provider.port` — di's `Provider(port)(…)` returns
`Provider<P, E, N> & { port: typeof port }`). There is no name to give: a
process serves one router / one activities record / one handlers record as
it boots one runtime (Thesis #1), so the port is framework-owned like
`HttpConfig` — `Port("HttpRouter")`, `Port("TemporalActivities")`,
`Port("AmqpHandlers")`, declared once each — and two providers for it in one
graph are di's duplicate-provider defect at build. The temporal and amqp
ports are generic at the value level and typed per contract at the type
level (`ActivitiesPortOf<C>`, `HandlersPortOf<C>`), so a provider built for
one contract still cannot be handed to a `TemporalModule` / `AmqpModule`
declaring another — structural on the record, not on a name. `Config.provider(name)(schema)`
is the one sugar that **keeps** its name: several config slices per
application is normal, and the name is what `ConfigInvalid` prints. **The
contract types
the record, and nothing wraps a leaf**: an oRPC procedure, a Temporal activity
and an AMQP handler are each a plain function typed by the contract at the
call (`HttpRouter` does `implement`/`.result`/`os.router` itself; the
temporal starter calls `declareActivitiesHandler`; `WorkerInferHandlers`
accepts a bare function), so an application never writes `implement`,
`os.…`, `declareHandler` or `declareActivitiesHandler`. The class line, its
name and its service type are what disappear; the port stays a real di port.
One rule from di's CLAUDE.md applies to writing one: return a type spelled
through the exported `PortClassOf`/`PortInstance` (the class expression's own
type is not nameable in declaration emit — which is also why the fixed ports
are `Port(name)` cast to `PortClassOf`, not `class` lines). Pinning
(`http({ port: 0 })`) is `Config.pinned(value, field)`, one helper for every
starter. `http()` binds
`PORT`/`HOST` onto `HttpConfig`, mounts the router the application provides
on **`HttpRouterPort`** —
an oRPC router as a provider that declares the use cases its procedures call
— under `prefix` through oRPC's own node adapter, and provides
`HttpRuntime`; **oRPC is the one way HTTP is answered here** (oRPC shares this
stack's convictions — a
contract, typed errors, `Result` at the boundary — so it is enforced, not
offered among alternatives; the former `@btravstack/orpc` was folded in for
that reason, and the node listener port `HttpHandler` is internal to the
package). `temporal({ contract, workflows })`
binds `TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE` onto `TemporalConfig`, opens
`TemporalConnection` as a resource and provides `TemporalRuntime` from the
activities the application provides on **`TemporalActivitiesPort`** —
implementations built by a provider from
the application's own services, closures, no `context.ctx`; `amqp({ contract
})` binds `AMQP_URL` onto `AmqpConfig` and provides `AmqpRuntime`
from the handlers on **`AmqpHandlersPort`** the same way. The runtime provider
depends on that port through di, which is what deleted `needs` from all
three: what a handler needs is its provider's business. A starter has real
dependencies — peers, so an application holds one copy: `@btravstack/http` on
`@orpc/server`/`@orpc/contract`/`@unthrown/orpc`, `@btravstack/temporal` on
`@temporal-contract/*` and `@temporalio/*`, `@btravstack/amqp` on
`@amqp-contract/*` — while the kernel and `config` still have none.

## Toolchain & conventions

- **`examples/` is part of the gate, not a folder of illustrations.** All
  ten workspaces run under the same six commands as the kernel — their specs
  plus four `needs-gate.test-d.ts` files, four `layering.test-d.ts` ones and
  `hexagonal-order-api`'s `index.test-d.ts` —
  so an example that stops compiling, stops linting or stops passing fails CI
  exactly as `packages/core` would. Three of the four needs-gate files pin
  **`start`'s** gate (`order-api`, `order-temporal-worker`,
  `order-amqp-worker` — its `NO RUNTIME` arm, since no starter's runtime
  declares a `needs` any more; `order-api`'s also pins the `unit` halves) and
  **di's** need on the starter's port (a composition importing `http()` /
  `temporal({ contract, workflows })` / `amqp({ contract })` without providing
  the router / activities / handlers carries the starter's port as an unmet
  need `start` refuses); the fourth,
  `order-application`'s, pins **di's** `UNSATISFIED DEPENDENCIES` gate on
  `Module.scoped`. They are different gates and easy to conflate. `start`'s
  `UNSATISFIED RUNTIME NEEDS` arm is pinned only by `packages/core`'s own
  `start.test-d.ts`, since every shipped runtime declares `needs: []`.
  `examples/` stays the only place the gate is pinned by a **type test** —
  `@btravstack/http` ships no `*.test-d.ts`; its 24 specs across
  `http-runtime.spec.ts` and `orpc.spec.ts` drive the transport through the
  internal `httpModule` with a bare listener, and the starter proper through
  `HttpModule`.
- **`examples/order-temporal-worker` is the one workspace whose suite needs the
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
  `btravstack/tools`'s `ci-reusable.yml@workflows-v1`, and a caller cannot
  inject an `actions/cache` step into a reusable workflow's jobs. Closing it
  means adding a cache-path input there, not here; until then every test job
  pays the ~3.5 s download.
- **`packages/amqp` and `examples/order-amqp-worker` are the two workspaces
  whose suites need a Docker daemon**, per the integration-test rule below.
  `@amqp-contract/testing` boots one real RabbitMQ container per vitest run
  (`globalSetup`) — the retry/dead-letter routing this package leans on is the
  broker's own behaviour, not something an in-memory fake or a local binary
  could stand in for. Measured on this machine: `packages/amqp`
  **17.6 s cold** (image pull included), **7.3–8.0 s warm**; `examples/order-amqp-worker`
  **15.5 s cold**, **4.8–5.6 s warm** — both slower than `order-temporal-worker`'s
  network-cache case, and cold only on a machine that has never pulled
  `rabbitmq:4.2.1-management-alpine` before.
- **The Prisma client is generated at test time, and there is nothing to
  install.** `@btravstack/example-order-infrastructure`'s `generate`
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
- **`examples/order-temporal-worker` consumes `@btravstack/temporal`**, the same
  way `order-api` consumes `@btravstack/http`: it supplies the contract, the
  activities provider and the `mapErrCases` triage, and reads `{ taskQueue,
namespace }` back off `Serving.info`. The Worker's lifecycle, the unit per
  attempt and the deadline race are the package's. Its activities are a
  **provider** on the starter's activities port
  (`orderActivities = TemporalActivities(orderContract)([…], { sync })`),
  built from `PlaceOrder`, `OrderRepository`,
  `StockService` and `ShippingService` — closures over the services, no
  context read at call time — and the composition root is
  `TemporalModule("OrderTemporalWorker")({ contract, activities:
orderActivities, workflows, imports })`, the sugar importing the starter;
  the connection and `TEMPORAL_*` come from the starter. `order-amqp-worker` is
  the same shape (`orderHandlers = AmqpHandlers(orderContract)([Logger], {
sync })`,
  `AmqpModule("OrderAmqpWorker")({ contract, handlers: orderHandlers, … })`),
  with its outbox relay a resourceful provider of its own rather than
  something layered onto the runtime.
- **`examples/order-api` consumes `@btravstack/http` rather than
  hand-rolling a transport, and its HTTP stack is the package's ONE way: oRPC
  over its own node adapter, `@unthrown/orpc` at the boundary.** The router is a di-provided
  service — `orderRouter` is a provider that **declares** `PlaceOrder` and
  `FindOrder`, so oRPC's context stays empty and nothing is located from a
  context at call time, never a module-level singleton — and
  **`HttpModule("OrderApi")({ router: orderRouter, imports: [Application,
Persistence], exports: [Logger] })`** is the whole composition root — the
  sugar imports `http()`, provides the router on the starter's
  `HttpRouterPort` and
  exports `HttpRuntime`: `OrderApi` is a constant, `PORT`/`HOST` come from the
  environment inside the graph, the router is mounted under `/rpc`. `RequestModule` rides `StartOptions.unit` so
  the per-request fork is the kernel's. There is no `runtime`, `needs`,
  `handler`, `port` or env-reading to spell anywhere: `main.ts` is `await
runMain(OrderApi, { unit: RequestModule })`. Each procedure is a plain
  `Result`-returning function typed by the contract (`@unthrown/orpc`'s
  `.result()` handler, attached by `HttpRouter(orderContract)`). It reads
  `port` back off
  `Serving.info`; binding, the drain and the trace-id policy are the
  package's. Two gates keep the composition honest at compile time: a root
  that forgets `http()` fails on arity (`NO RUNTIME`), and one that imports
  it without providing `orderRouter` fails di's own gate at `start`, since the
  starter's runtime provider depends on its router port.
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
  dependencies of `@btravstack/core` — the dual-copy hazard is real for both (di's port
  identity and unthrown's `isResult` each compare across copies). `@btravstack/http`
  peers on both of those plus `@btravstack/core` itself, for the same reason.
  `node:` builtins only otherwise. Do not add a dependency — `Config` is
  hand-rolled Standard Schema for exactly this reason. `@btravstack/di`
  living in this workspace does **not** change that: it is linked with
  `workspace:*` in `devDependencies` and stays `^0.1.0` in `peerDependencies`,
  so a consumer still installs one copy of it themselves. `di` itself peers on
  `unthrown` and depends on nothing; `config` peers on `di` and `unthrown`;
  `core` peers on all three; `testing` peers on all four (and not on
  `vitest` — `bootFixture` is a plain function in vitest's fixture shape). A
  **starter** is the exception by definition:
  `@btravstack/http` peers on `@orpc/server`, `@orpc/contract` and
  `@unthrown/orpc` — peers, not dependencies, so an application holds one
  copy of each.
- **`packages/core`'s specs use `@btravstack/testing`, which peers on core —
  and it is NOT a devDependency of core**, because that would be a
  package-graph cycle turbo refuses. Instead: `packages/core/tsconfig.json`
  maps `paths: { "@btravstack/testing": ["../testing/dist/index.d.mts"] }`
  for the type checker (the built d.ts — the source would fall outside
  `rootDir`), and `tsconfig.build.json`, what `tsdown` compiles, empties
  `paths` and excludes the specs so the published `dist` never sees it;
  `packages/core/vitest.config.ts` aliases `@btravstack/testing` to
  `../testing/src/index.ts` and `@btravstack/core` to `./src/index.ts` (one
  kernel in play; coverage measures what the specs run); `turbo.json` gives
  `@btravstack/core#typecheck` an explicit edge on
  `@btravstack/testing#build`; `knip.json` ignores the dependency for
  `packages/core`. Four places; a change to one is a change to all.
- `declarationMap: false` on all seven published packages — the published
  tarball has no `src/`, so maps would be dead ends.
- **Relative imports carry `.js`.** `moduleResolution: NodeNext` plus
  `verbatimModuleSyntax`, both inherited from `@btravstack/tsconfig/base.json` —
  an external package under `node_modules`, so this is the one convention here
  the repo itself cannot show you. `import { x } from "./units"` fails
  `pnpm typecheck` with TS2835.
- All seven published packages claim `engines: { node: ">=20" }` while the root
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
  So a `throw` is a lint error everywhere, spec files included: every one
  that survives carries an `oxlint-disable-next-line unthrown/no-throw`
  naming why. In the kernel and the harness they fall into three kinds — a
  **loud test fixture** whose failure means the _test_ is buggy
  (`packages/testing`'s `test-runtime.ts`'s two misuse guards and
  `tapped.ts`'s read-before-boot; `packages/core`'s `invariants.spec.ts`'s
  `boundPort`), a **harness rethrow** that is the only way a defect or a
  `use` failure reaches the test runner (`with-app.ts`'s two,
  `boot-fixture.ts`'s one), and a throw that **is the subject under test**
  (`events.spec.ts`'s throwing sink, `units.spec.ts`'s throwing unit, and the
  defects `run-main.spec.ts`, `drain.spec.ts` and `with-app.spec.ts` mint —
  `Defect` has no public constructor, so a throw inside a combinator is the
  only way — plus `with-app.spec.ts`'s stand-in for a failing `expect`): five
  in `packages/core/src`, eight in `packages/testing/src`. `no-get-or-throw` is switched off for the `**/*.spec.ts` **and
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
- Coverage thresholds are 100% lines/functions on `packages/core` and on
  `packages/testing`, with each package's `test-fixtures.ts` (test code, per
  the Test conventions) excluded.
- Test mechanics: `@unthrown/vitest`'s matchers are registered via `setupFiles`
  (`toBeOk`, `toBeOkWith`, `toBeErrTagged`, …). Timing is asserted through
  `createFakeClock`, never a real `setTimeout` — a kernel whose own tests are
  slow gets tested badly. `*.test-d.ts` files are excluded from the build, from
  oxlint and from knip; they are checked by `tsc -p tsconfig.test-d.json`, which
  `pnpm typecheck` runs. The structural rules are in **Test conventions** below.
- Documentation drifts silently, and a sibling repo has already shipped a
  falsehood this way. When the public surface changes, update **this** file,
  the documentation site's page for it (see **Documentation site** below),
  the package README if its sample is touched, **and**
  `docs-examples.test-d.ts` in the same commit — and when
  the change is to `packages/core/src/` internals or the invariants guarding
  them, `packages/core/CLAUDE.md` too — and for a runtime package, its own:
  `packages/config/CLAUDE.md`, `packages/testing/CLAUDE.md`,
  `packages/http/CLAUDE.md`, `packages/temporal/CLAUDE.md` or
  `packages/amqp/CLAUDE.md`, whichever is where that package's public
  surface lives — or `packages/di/CLAUDE.md` for the container. There are
  **eight** `CLAUDE.md` files; naming the wrong one is how the last drift
  happened.

## Documentation site

`docs/` is `@btravstack/docs`, the VitePress site published to
`https://btravstack.github.io/start/` — the same tooling and shape as
`unthrown`'s: `@btravstack/theme`, one shared sidebar over the four Diátaxis
modes (`tutorial/`, `how-to/`, `reference/`, `explanation/`), `examples/`
walkthroughs of the ten example workspaces, and a TypeDoc-generated
`api/<pkg>/` per published package. `@btravstack/di`'s former standalone site
was folded in here when the container was merged; nothing under
`docs/reference/di/` should be edited in the old repository.

- **TypeDoc runs from `docs/`, not from the packages** — it needs its own
  TypeScript (`catalog:typedoc` pins 6.0.3; 7.x is the native port and ships
  no `typescript.js`). One `typedoc.<name>.json` per package — seven — points
  at that package's `src/index.ts` (core's one entry point; the doubles are
  `typedoc.testing.json`'s) and writes straight into `api/<name>/`
  (gitignored; `docs/api/index.md` is the one committed file there);
  `scripts/build-api.ts` runs the seven concurrently.
  The package list is repeated in four places that must stay in sync: the
  configs, `build-api.ts`, `@btravstack/docs#build`'s `dependsOn` in
  `turbo.json` (explicit `<pkg>#build` edges — the site does not _depend_ on
  the packages, but a cross-package import inside a documented source must
  resolve), and the `/api/` sidebar in `.vitepress/config.ts`. Each config's
  `intentionallyNotExported` lists the internal helper types TypeDoc would
  otherwise warn about; a new unexported-but-referenced type goes there.
- **Deployed by `.github/workflows/deploy-docs.yml`**, chained off a green CI
  run on `main` (`workflow_run`, checking out the exact `head_sha` CI
  measured) or by `workflow_dispatch`. Unversioned: `main` deploys alone to
  the root. `unthrown`'s stable/beta split (`DOCS_BASE`, `DOCS_VERSIONS`) is
  the shape to adopt once a stable tag exists.
- **Every TypeScript sample on the site was compiled when written** — in a
  scratch file inside the workspace whose dependencies it needs
  (`packages/core/src/` for kernel/di/config samples, `examples/order-api/src/`
  for HTTP, the two worker examples for Temporal and AMQP), then deleted. The
  kernel-only samples are additionally held by
  `packages/core/src/docs-examples.test-d.ts`; the starters' are not (see
  Deferred). A sample edited on the site is re-compiled the same way.
- Pages carry frontmatter `title` and `description`, open with the quadrant
  blockquote (`> **How-to.** …`), and link root-relative (`/reference/core/start`).
  The house style is `unthrown`'s; read a page there before writing one here.
- `pnpm --filter @btravstack/docs build` builds the site (TypeDoc, then
  VitePress); `pnpm --filter @btravstack/docs dev` serves it. Neither is in
  the six-command gate — `knip` covers `docs/scripts`, and the deploy
  workflow is what fails on a dead link.

## Test conventions

Five rules, each with the reason it exists — binding at two different scopes,
which is a decision rather than an accident.

**Rules 4 and 5 are substantive and bind everywhere**, `packages/core`
included. They are what stops an assertion silently declining to run: a
conditional or optional-chained `expect` skips without failing the test, and a
scatter of shallow assertions hides which one is load-bearing. That shape was
caught three separate times in review, which is why it is a rule and not a
preference.

**Rules 1 to 3 are structural and bind `examples/`**, the teaching surface,
where the shape of a spec is itself read as advice. Ten of the kernel's 12 spec
files predate them (`config.spec.ts` and `unit-module.spec.ts` are the two
written since; `test-runtime`, `fake-clock` and `with-app` moved to
`packages/testing` with the harness and predate them too) and are
**deliberately not swept**: they are mutation-verified, hold
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

6. **Configuration is a provider bound from `Env` through a schema, never
   `process.env` read by hand and never `.parse()`d.** The kernel owns it:
   `Config.provider(Port)(Config.object({...}))` reads the `Env` port the
   kernel provides, validates once as the graph is built, and answers a
   modeled `ConfigInvalid` — every offending variable named — which `runMain`
   turns into `startFailed` on stderr and exit code `78`. Nothing in an
   application touches `process.env`, and no `main.ts` folds issues into a
   message and an exit code itself; `examples/order-api/src/main.ts` is one
   line. A schema's own `.parse()` **throws**, which `unthrown/no-throw` bans.
   The semantics `Config.*` fixes once (pinned by `config.spec.ts`'s cases:
   absent, `""`, whitespace, `abc`, `3.5`, valid, out of range, a pin, a
   required field): an **empty or blank value is a configuration
   error, not an absent one** — `default` applies only to a variable nobody
   set — because `Number("")` is `0`, and `PORT=` would otherwise bind the
   ephemeral port; a **port's floor is `0`** so an ephemeral bind stays
   expressible, which is why that guard cannot be a lower bound; integers are
   `Number()` + `isInteger` + inclusive bounds, so `abc`, `3.5` and
   out-of-range are all named. Any Standard Schema is accepted in place of
   `Config.object` (a `zod` object over the raw variables) — the practice
   _"Accept any Standard Schema validator"_ — but the fields exist so the
   framework's own starters, and an application with ordinary needs, bring no
   schema library at all. `examples/order-config` and the three `env.ts`
   files were the earlier shape (a shared zod fragment, `readEnv()`,
   `describeEnvIssues`, `abort(78)` by hand in every `main.ts`); they were
   deleted when the kernel took this over.

## Deferred, deliberately

- **Caching the Temporal test-server binary in CI.** The path is stable and
  gitignored; what is missing is the `actions/cache` step, which cannot be
  written from `start`'s `ci.yml` while it delegates to
  `btravstack/tools`'s reusable workflow (see Toolchain & conventions). It
  costs ~3.5 s per test job, not correctness.
- The `@btravstack/oxlint` rule banning `currentUnit()` outside infrastructure
  adapters (Thesis #2) — it needs a way to identify an adapter.
- **A `docs-examples.test-d.ts` for `@btravstack/http`, `@btravstack/temporal` and
  `@btravstack/amqp`.** `packages/core`'s exists precisely so its README and
  the kernel-only pages of the documentation site cannot drift from
  `runtime.ts` / `drain.ts` without failing `pnpm typecheck`; the three
  runtime packages' README and site samples have no such gate — they were
  compiled by hand in a scratch file inside the matching example workspace
  when written, and by nothing since. Deliberately not built — three
  packages' worth of samples still did not justify the harness. Add it the
  next time one of those samples is found to have drifted, the same way this
  gap itself was found.
- ~~Bringing `packages/core`'s 13 spec files under the Test conventions.~~
  **Closed by decision, not by doing it** (three of the 13 — `test-runtime`,
  `fake-clock`, `with-app` — have since moved to `packages/testing`, on the
  same terms). An audit of the 93 tests found the
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
