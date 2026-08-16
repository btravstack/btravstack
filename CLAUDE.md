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

pnpm workspace + turbo monorepo. `packages/` holds eight published packages,
`di` (the container), `config` (configuration from the environment, as
providers), `core` (the kernel), `testing` (the test harness — `bootFixture`,
`tapped`, the in-memory runtime, the fake clock; peers on `core`),
`observability` (the logging starter — a `Logger` port correlated with the
ambient unit, a JSON sink, the kernel's events as lines), `http`
(the HTTP starter — oRPC), `temporal` (the Temporal starter) and `amqp` (the
AMQP starter). `di` was its own repository until it was merged here
**with its history**; it is the one package that depends on nothing else in
this workspace, and the dependencies run `core` → `config` → `di`, never
back, with `testing`, `observability` and the three transport starters on
`core`. Its own spec is `packages/di/CLAUDE.md`; the harness's is
`packages/testing/CLAUDE.md`; the logging starter's is
`packages/observability/CLAUDE.md`.
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

## Versioning: all eight packages move as one

The eight published packages share **one version number**, enforced by a
`fixed` group in `.changeset/config.json`. A release bumps every one of them,
whether or not it changed — Spring Boot's model, and the reason is the same:
an application installs a kernel and two or three starters together, and
"which version of `@btravstack/http` goes with `@btravstack/core@0.4.1`" is a
question nobody should have to answer.

`@btravstack/di` is the only one with a published history (`0.1.0`, from its
standalone repository, before the merge). The unified line therefore starts at
**0.2.0**: above di's published version, and 0.x because the API still moves —
this repo removed `Port.many` and `withApp` in a single afternoon.

**A minor bump lands on 1.0.0, and that is changesets, not a decision.** Every
package here peer-depends on `@btravstack/di` and most on `@btravstack/config`
and `@btravstack/core`, and changesets majors any package whose _peer_
dependency is bumped by a minor or major. From 0.x a major is `1.0.0`.
Measured on changesets 2.31.1:

| From 0.2.0          | Result                                 |
| ------------------- | -------------------------------------- |
| a `patch` changeset | `0.2.1` — the whole group, as intended |
| a `minor` changeset | `1.0.0` — the whole group              |

Neither escape hatch suppresses it. Both live under
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`, **not** in the ordinary
config, and neither is the `updateInternalDependencies` this repo's
`.changeset/config.json` already sets — the names are close enough to mislead,
so: `onlyUpdatePeerDependentsWhenOutOfRange: true` and
`updateInternalDependents: "out-of-range"`, both read by
`@changesets/assemble-release-plan`, both tried here, neither changing the
result. The internal peers cannot become ordinary dependencies either — the
dual-copy hazard is what they exist to prevent.

So the options at the first feature release are to accept `1.0.0`, or to
override the computed version by hand as the `0.2.0` release did: run
`changeset version`, then rewrite the eight `package.json` versions, the eight
`CHANGELOG.md` headings **and the `Updated dependencies` blocks inside those
changelogs**, which carry the computed version too and are easy to miss.
Decide it deliberately; do not let a routine `pnpm run version` decide it.

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
   `{ unitId, traceId, tenantId, deadline, signal }` (`UnitRecord` in
   `units.ts`) —
   and nothing else. Services never go in it. The line holds because what `di`
   exists to prevent is hidden _dependencies_: code that secretly needs a
   collaborator it never declared and cannot be tested without it. A trace id is
   not a collaborator — no substitutability question, no test double, nothing to
   swap. Nor is an `AbortSignal`: `signal` is the **very** controller the work
   callback is handed — one abort, two ways to reach it — and it is on the
   record because the callback is not always where the work is. A
   middleware-shaped runtime (`@btravstack/temporal`, `@btravstack/amqp`) opens
   the unit around a call it does not own the arguments of, so an activity or a
   handler has no parameter to receive it through, and injecting a context the
   contract does not type was the alternative and was rejected;
   `@btravstack/http` passes the same signal as its handler's third parameter,
   which is that signal by another route. A transport's own cancellation —
   Temporal's `Context.current().cancellationSignal` — is a **different clock**,
   not this one. A repository pulled from an ambient store is the untestable
   coupling; a
   tenant id read by the Postgres adapter is not. Legitimate readers are
   infrastructure adapters only (logger, OTel exporter, database adapter), and
   the logger is no longer hypothetical: `@btravstack/observability`'s
   `createLogger` reads `currentUnit()` **per call** and stamps `unitId` /
   `traceId` / `tenantId` on every line, so an application writes
   `logger.info("placing an order", { orderId, quantity })` and mentions
   correlation nowhere. Per call, not at construction, is the load-bearing
   half — one logger is built per scope and every unit has its own record.
   Application code reading the store is meant to be a lint error, in the spirit
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
   - **`@btravstack/testing`'s `bootFixture`** — vitest's own
     `(ctx, use) => Promise<void>` fixture protocol, which the harness does not
     get to choose. `use` is the test body: a thrown assertion failure inside
     it must reach the test runner, and an `AsyncResult` never rejects, so
     wrapping it would turn a failing `expect` into a `Defect` a caller can
     forget to unwrap — a green test that asserted nothing.

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

Each package's surface is stated **once**, in that package's own `CLAUDE.md`,
and again for a reader on the documentation site. It is deliberately **not**
restated here: this file used to carry a copy, and the copy drifted — it
described `Logger.error`/`fatal` as taking `(message, cause?, attributes?)`
while `logger.ts` shipped `(message, attributes?, cause?)` on all six methods
_and argued for that ordering in its own TSDoc_. Five copies, one gate, and
the copy with no gate is the one that lies.

| Package                     | Surface lives in                   | Reference page             |
| --------------------------- | ---------------------------------- | -------------------------- |
| `@btravstack/di`            | `packages/di/CLAUDE.md`            | `/reference/di/`           |
| `@btravstack/config`        | `packages/config/CLAUDE.md`        | `/reference/config`        |
| `@btravstack/core`          | `packages/core/CLAUDE.md`          | `/reference/core/`         |
| `@btravstack/testing`       | `packages/testing/CLAUDE.md`       | `/reference/testing`       |
| `@btravstack/observability` | `packages/observability/CLAUDE.md` | `/reference/observability` |
| `@btravstack/http`          | `packages/http/CLAUDE.md`          | `/reference/http`          |
| `@btravstack/temporal`      | `packages/temporal/CLAUDE.md`      | `/reference/temporal`      |
| `@btravstack/amqp`          | `packages/amqp/CLAUDE.md`          | `/reference/amqp`          |

What stays here is what no single package owns: the theses above, the footgun,
the two contracts a runtime owes, and the conventions below.

`packages/core/src/index.ts` is the one place the kernel's API is decided —
one entry point. The test doubles are `@btravstack/testing`, a package of its
own that peers on the kernel (the `@nestjs/testing` shape), so a production
bundle never pulls the fakes in and the kernel ships none.

There is **no** `Defect` construction, no `overrideProvider`, no accumulation
of runtimes, and no `recoverFailure`-style channel-moving helper. Swapping an
adapter is composing a different module, which di already documents and the
type checker already verifies.

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
  `examples/` is not the only place the gate is pinned by a **type test**:
  `packages/amqp/src/amqp-runtime.test-d.ts` pins the handlers-port half of
  `amqp`'s own gate, and `packages/http/src/controller.test-d.ts` pins the
  five compile-time gates the keyed `HttpRouter(contract)(controllers)` form
  owes (see `packages/http/CLAUDE.md`). `@btravstack/http`'s 26 specs, across
  `http-runtime.spec.ts`, `orpc.spec.ts` and `controller.spec.ts`, drive the
  transport through the internal `httpModule` with a bare listener, the
  starter proper through `HttpModule`, and the keyed router form through the
  `rpcSliced` fixture.
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
orderActivities, workflows, imports: [Application, Persistence, Fulfillment,
observability()] })`, the sugar importing the starter;
  the connection and `TEMPORAL_*` come from the starter, and `LOG_LEVEL` and
  the `Logger` the saga's stand-in services write to come from
  `observability()`. `order-amqp-worker` is
  the same shape (`orderHandlers = AmqpHandlers(orderContract)([Logger], {
sync })`,
  `AmqpModule("OrderAmqpWorker")({ contract, handlers: orderHandlers, imports:
[Application, Persistence, observability()], … })`),
  with its outbox relay a resourceful provider of its own rather than
  something layered onto the runtime — the relay is also the one place in the
  examples that logs a **failure**, `logger.error(message, cause, { eventId })`
  down each of its three arms. Both are also where **honouring the
  kernel's deadline through the ambient record** is worked: neither middleware
  injects anything into the call — `next()` unchanged — so
  `currentUnit()?.signal` is the only route to it, and what each answers when
  it is aborted is the transport's own business. `order-amqp-worker`'s
  `orderChanged` returns a `RetryableError`, leaving the delivery un-acked so
  the broker hands it to the next worker; `order-temporal-worker`'s
  `ShippingService.arrange` fails as a **defect**, which the platform retries
  on another worker — the contract's `ShippingUnavailable` is a permanent no
  and would be the wrong error for "we ran out of time".
- **A controller is a provider; a slice is a module; a modulith is several
  slice modules in one root.** No new concept: a slice owns its contract
  fragment, its controller and (if it needs one) its own adapter, and ships
  as an ordinary di `Module` that exports only its controller's port —
  everything else about the slice stays private. `@btravstack/http`'s
  `HttpController(name, fragment)([deps], { sync })` mints the controller's
  port; the root composes every slice's controller into one router with the
  keyed `HttpRouter(contract)(controllers)` form, exact against the contract
  (see `packages/http/CLAUDE.md`). **A fragment is itself a valid contract**,
  so a slice lifts out of the modulith into a process of its own without its
  controller changing at all — extracting it is deleting an import at the
  root, not a rewrite. This is what makes composing several slices into one
  router a starting point rather than a trap, and it is the one property
  marked do-not-break in the design.
- **`examples/order-api` consumes `@btravstack/http` rather than
  hand-rolling a transport, and its HTTP stack is the package's ONE way: oRPC
  over its own node adapter, `@unthrown/orpc` at the boundary.** It is a
  two-slice modulith on the shape above: `slices/orders/` and
  `slices/customers/`, each its own contract fragment, its own
  `HttpController` and its own di module exporting only that controller's
  port. The root composes them —
  `orderRouter = HttpRouter(orderContract)({ orders: ordersController,
customers: customersController })`, the keyed form — and
  **`HttpModule("OrderApi")({ router: orderRouter, imports: [Application,
Persistence, OrdersSlice, CustomersSlice, observability()], exports:
[Logger] })`** is the whole
  composition root — the
  sugar imports `http()`, provides the router on the starter's
  `HttpRouterPort` and
  exports `HttpRuntime`: `OrderApi` is a constant, `PORT`/`HOST` come from the
  environment inside the graph, the router is mounted under `/rpc`.
  `observability()` is what provides the `Logger` the interactors and the
  request scope write to, and `Logger` is in `exports` because `RequestModule`
  reads it out of the application scope. `RequestModule` rides
  `StartOptions.unit` so
  the per-request fork is the kernel's. There is no `runtime`, `needs`,
  `handler`, `port` or env-reading to spell anywhere. It is also the **one**
  `main.ts` that is not a single line: it passes
  `onEvent: kernelEvents(createLogger(jsonSink()))` so the kernel's nine events
  land in the application's own stream, with the logger built by hand because
  `building` is emitted while the graph still is. The other two stay one line
  — the kernel's stderr sink is a fine default and this is the upgrade, not
  the requirement. Each procedure is a plain
  `Result`-returning function typed by its slice's fragment (`@unthrown/orpc`'s
  `.result()` handler, attached inside each `HttpController`). It reads
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
  living in this workspace does **not** change that: it is `workspace:*` in
  `devDependencies` and `workspace:^` in `peerDependencies` — the same
  protocol as every other in-repo peer, which pnpm rewrites to a real `^`
  range at publish, so a consumer still installs one copy themselves. It was
  a hardcoded `^0.1.0` until the versions went lockstep; a literal range in a
  peer field is a pin that goes stale silently the first time the dependency
  is bumped. `di` itself peers on
  `unthrown` and depends on nothing; `config` peers on `di` and `unthrown`;
  `core` peers on all three; `testing` peers on all four (and not on
  `vitest` — `bootFixture` is a plain function in vitest's fixture shape);
  `observability` peers on all four too and has **no runtime dependency of its
  own** — the default sink is `JSON.stringify` and a `write`. A
  **starter** is the exception by definition:
  `@btravstack/http` peers on `@orpc/server`, `@orpc/contract` and
  `@unthrown/orpc` — peers, not dependencies, so an application holds one
  copy of each. `@btravstack/observability` carries the family's one
  **optional** peer, `pino`, needed only by the
  `@btravstack/observability/pino` subpath: a consumer that never imports it
  never installs it, and the package's own `tsdown` build emits `src/pino.ts`
  as a second entry point for exactly that.
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
- `declarationMap: false` on all eight published packages — the published
  tarball has no `src/`, so maps would be dead ends.
- **Relative imports carry `.js`.** `moduleResolution: NodeNext` plus
  `verbatimModuleSyntax`, both inherited from `@btravstack/tsconfig/base.json` —
  an external package under `node_modules`, so this is the one convention here
  the repo itself cannot show you. `import { x } from "./units"` fails
  `pnpm typecheck` with TS2835.
- All eight published packages claim `engines: { node: ">=20" }` while the root
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
  in `packages/core/src`, eight in `packages/testing/src`, two in
  `packages/observability/src` (`test-fixtures.ts`'s `Recorder.only()`, a loud
  fixture guard, and `logger.spec.ts`'s throwing sink, which is the subject
  under test). `no-get-or-throw` is switched off for the `**/*.spec.ts` **and
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
- Coverage thresholds are 100% lines/functions on `packages/core`,
  `packages/testing` and `packages/observability`, with each package's
  `test-fixtures.ts` (test code, per the Test conventions) excluded.
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
  **nine** `CLAUDE.md` files; naming the wrong one is how the last drift
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
  no `typescript.js`). One `typedoc.<name>.json` per package — eight — points
  at that package's `src/index.ts` (core's one entry point; the doubles are
  `typedoc.testing.json`'s, and `typedoc.observability.json` names two entry
  points, `src/index.ts` and `src/pino.ts`) and writes straight into
  `api/<name>/` (gitignored; `docs/api/index.md` is the one committed file
  there); `scripts/build-api.ts` runs the eight concurrently.
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
  for HTTP and for `@btravstack/observability`, the two worker examples for
  Temporal and AMQP), then deleted. The one sample that cannot be compiled
  that way is `pinoSink`'s — no example workspace installs `pino` — and it is
  held by `packages/observability/src/pino.spec.ts` instead. The
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
- **Traces and metrics in `@btravstack/observability`.** The package is named
  for the whole because logs, traces and metrics share a correlation id, a
  resource, a config slice and a flush-on-shutdown lifecycle; only the logging
  half ships. The shape the rest will take — `Tracer`/`Meter` ports, the OTel
  `NodeSDK` as a resourceful provider whose `release` flushes, a span per unit
  through `StartOptions.unit`, W3C `traceparent` feeding `UnitMeta.traceId` in
  the three transport starters — and the auto-instrumentation constraint that
  will not go away are in `packages/observability/CLAUDE.md`. Never describe
  them as shipped.
- **A `docs-examples.test-d.ts` for `@btravstack/http`, `@btravstack/temporal`,
  `@btravstack/amqp` and `@btravstack/observability`.** `packages/core`'s exists precisely so its README and
  the kernel-only pages of the documentation site cannot drift from
  `runtime.ts` / `drain.ts` without failing `pnpm typecheck`; the three
  four other packages' README and site samples have no such gate — they were
  compiled by hand in a scratch file inside the matching example workspace
  when written, and by nothing since. Deliberately not built — four
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
