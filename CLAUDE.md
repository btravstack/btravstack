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

pnpm workspace + turbo monorepo. `packages/` holds twelve published packages,
`contract` (contract-level markers shared by a client and the server that
implements it — zero dependencies, zero peers), `di` (the container), `config`
(configuration from the environment, as
providers), `core` (the kernel), `testing` (the test harness — `bootFixture`,
`tapped`, the in-memory runtime, the fake clock; peers on `core`),
`observability` (the observability starter — `createLogger` correlated with
the ambient unit, a JSON sink, the kernel's events as lines, and the OTel
adapter behind its own subpath; it IMPLEMENTS the `Logger`, `Tracer` and
`Meter` ports rather than declaring them, which is `core`'s job), `cache`
`mailer` and `storage` (the three application-service ports of issue #62, on
one shape — a port, a real adapter, an in-process adapter, and one
composition function whose `instrumented` flag defaults to on), and the three
**servers**, each named for the half it implements: `http-server` (oRPC over
`node:http`), `temporal-worker` and `amqp-worker`. `di` was its own repository until it was merged here
**with its history**; it and `contract` are the two packages that depend on
nothing else in
this workspace, and the dependencies run `core` → `config` → `di`, never
back, with `testing`, `observability`, the three application-service ports
and the three servers on `core`. Its own spec is `packages/di/CLAUDE.md`; `contract`'s is
`packages/contract/CLAUDE.md`; the harness's is
`packages/testing/CLAUDE.md`; the logging starter's is
`packages/observability/CLAUDE.md`.
`examples/` holds ten private ones — a clean-architecture application
(`order-domain` → `order-application` → `order-infrastructure`) booted under
three runtimes (`order-api`, `order-temporal-worker`, `order-amqp-worker`),
each doing what its transport is for — answering, orchestrating,
broadcasting — with each transport's contract in a package of its own
(`order-api-contract`, `order-temporal-contract`, `order-amqp-contract`)
because a client must be able to take a contract without the server, plus the
container's own `hexagonal-order-api`, which composes a `Module` and never
calls `start`. They are
consumers, not fixtures: they are part of the gate, and `examples/README.md`
is their index.

**`hexagonal-order-api` is two things, and the second is why it cannot be
deleted.** The example half is di used alone — ports named by the
application, a production adapter and an in-memory one. The other half,
`src/emit-guards.ts` with `tsconfig.emit.json`, is the repository's **only**
check that a consumer which exports a port can emit its own declarations: its
`typecheck` runs five passes, emitting `.d.ts` under the repo's TypeScript and
again under `typescript-consumer` (the version a consumer realistically has),
then re-checking the emitted output under that second compiler. It is the only
workspace here that compiles twice, and the only reason that catalog entry
exists. It was added because the `TS4020` class of bug had already shipped —
every consumer exporting a port failed to emit, while the repo stayed green
because the examples carried `declaration: false` — which is the sharpest
version of "green gate, no consumer can build" this repo has met. Do not
judge the workspace by the example half; a reader who does concludes it is
redundant with `order-api`, which is exactly the mistake the name invites. `docs/` is the documentation site (see **Documentation
site** below); it is a workspace but not a published package. `internal/`
holds one more, `test-infra`, which is neither: it owns the six containers
the whole gate shares and is documented in its own README.

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

Not part of the gate, but the command a contributor runs all day:

```sh
pnpm dev              # the three example deployments, one process each, watching
```

Commits follow Conventional Commits (commitlint via a lefthook `commit-msg`
hook). User-facing changes need a changeset.

## Versioning: all twelve packages move as one

The twelve published packages share **one version number**, enforced by a
`fixed` group in `.changeset/config.json`. A release bumps every one of them,
whether or not it changed — Spring Boot's model, and the reason is the same:
an application installs a kernel and two or three starters together, and
"which version of `@btravstack/http-server` goes with `@btravstack/core@0.4.1`" is a
question nobody should have to answer.

`@btravstack/di` is the only one with a published history (`0.1.0`, from its
standalone repository, before the merge). The unified line therefore starts at
**0.2.0**: above di's published version, and 0.x because the API still moves —
this repo removed `Port.many` and `withApp` in a single afternoon.

**A minor no longer forces 1.0.0 — `@changesets/cli@3.0.0` fixed it.** Every
package here peer-depends on `@btravstack/di` and most on `@btravstack/config`
and `@btravstack/core`, and changesets 2.x majored any package whose _peer_
dependency was bumped by a minor or major; from 0.x a major is `1.0.0`, so one
`minor` changeset took the whole group there. Re-measured on **3.0.0**, twice,
against the four pending changesets:

| From 0.2.0          | on 2.31.1                 | on 3.0.0    |
| ------------------- | ------------------------- | ----------- |
| a `patch` changeset | `0.2.1` — the whole group | `0.2.1`     |
| a `minor` changeset | `1.0.0` — the whole group | **`0.3.0`** |

Only the `minor` row moved, and it moved to what the repo wanted all along.
The escape hatches the 2.x note prescribed are moot: both lived under
`___experimentalUnsafeOptions_WILL_CHANGE_IN_PATCH`, **not** in the ordinary
config, and neither was the `updateInternalDependencies` this repo's
`.changeset/config.json` already sets — the names are close enough to mislead
(`onlyUpdatePeerDependentsWhenOutOfRange: true`,
`updateInternalDependents: "out-of-range"`, both read by
`@changesets/assemble-release-plan`, both tried, neither changing the 2.x
result). The internal peers still cannot become ordinary dependencies — the
dual-copy hazard is what they exist to prevent.

So the hand-override the `0.2.0` release performed — rewriting the eight
`package.json` versions, the eight `CHANGELOG.md` headings **and the
`Updated dependencies` blocks inside those changelogs** — is no longer needed
for a feature release. Reaching `1.0.0` is a decision again rather than an
accident. **Do not downgrade `@changesets/cli` below 3.0.0** without
restoring this warning: on 2.x the next `pnpm run version` silently ships a
major.

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
   make this testable rather than asserted: the same `OrderApplicationModule` +
   `OrderPersistenceModule` composition under three runtimes, with the same
   `DuplicateOrder` arriving as a typed `CONFLICT` on the first and a
   `nonRetryable` typed contract error on the second — the third is a
   broadcast, where a placement's `Err` never crosses the broker and only the
   committed fact does, relayed from a transactional outbox — and no mapping
   anywhere near the kernel. The second is also where
   `Serving.drain` first meets a transport with real drain semantics of its
   own — which is why that half now lives in `@btravstack/temporal-worker`, the
   package the example consumes: `worker.shutdown()` stops polling immediately and `run()` resolves only
   once the in-flight activity has finished, so `drain` is a genuine wait
   rather than the "stop accepting, nothing left to await" the other two are.
   It is also the first runtime that has to **honour** the deadline
   `AbortSignal` rather than merely note it: `run()` settles on Temporal's own
   `shutdownForceTime`, so an activity that never finishes would hold
   `Serving.stop` well past the kernel's `drainTimeoutMs` unless the signal is
   raced against it — and `@temporalio/worker` exposes no public forced
   shutdown to escalate to, so "stop waiting" is the escalation.

   **The local loop is the production shape, not an exception to it** (issue
   #67). Three deployments meant three terminals, and the tempting fix — a
   kernel API booting all three in one process, which `start` would happily
   support — was measured and declined: it cannot watch (reloading an ESM
   graph in place is a bespoke loader), it shares one event loop and the
   process-global uncaught handlers, so one crash takes all three down and a
   blocking worker starves the API, and it exercises the drain through one
   shared signal instead of three real ones. A dev loop that misrepresents
   failure isolation teaches the wrong lesson about the very thesis it sits
   under. So `pnpm dev` is `turbo run dev --filter=./examples/*`: one process
   per deployment, `tsx watch` on each, output prefixed by workspace — see
   **The local loop** under _Toolchain & conventions_.

   **The transport role map is a decision, not an inventory** (issues #61 and
   #60): answering is `@btravstack/http-server`; orchestration — and with it
   everything job-queue-shaped and everything scheduled — is
   `@btravstack/temporal-worker`; broadcasting is `@btravstack/amqp-worker`. There is no
   job-queue runtime and no scheduler runtime to come. A workflow already IS
   a durable job with a handle — retries, per-attempt budgets, delay,
   idempotency keys and a result that outlives the caller are Temporal's own
   primitives, and Temporal Schedules are the cron — where a queue package
   would re-ship those semantics over a broker that models announcements
   ("AMQP carries announcements, orchestration carries intent", the amqp
   contract's own line). A workload the map does not cover is a new decision
   to record here, never a fourth runtime by default.

   **Each transport package is named for the HALF it implements, and the
   other half's name is reserved.** `http-server`, `temporal-worker` and
   `amqp-worker` — not `http`, `temporal`, `amqp`, which claimed a whole
   transport and delivered the serving side of it. The calling side exists
   today as somebody else's library, used directly by the examples
   (`@orpc/client`, `@temporal-contract/client`, `@amqp-contract/client`),
   and when this family grows its own they take `-client` names beside these.
   Three things decided the spelling:
   - **The neighbours qualify both sides** — `@orpc/server`/`@orpc/client`,
     `@temporal-contract/worker`/`/client` — so an unqualified name reads as
     the umbrella containing both, which is exactly what it is not.
   - **"worker" rather than a uniform `-server`**, because it is Temporal's
     and AMQP's own word, and because `temporal-server` already means the
     Temporal Service — the cluster `internal/test-infra` runs as
     `temporalio/auto-setup`. A name that suggests you are booting the
     cluster is worse than a suffix that varies.
   - **A client will be a PACKAGE, never a subpath.** Peers are per-package,
     so `@btravstack/http-server/client` would drag `@orpc/server` into a
     consumer that only ever calls — the same reason `examples/*-contract`
     are packages of their own: a client must be able to take a contract
     without the server.

   The rename cost nothing because only `@btravstack/di` had ever been
   published (`0.1.0`); after the first release it would have cost a
   deprecation cycle, which is why it happened when it did.

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
   middleware-shaped runtime (`@btravstack/temporal-worker`, `@btravstack/amqp-worker`) opens
   the unit around a call it does not own the arguments of, so an activity or a
   handler has no parameter to receive it through, and injecting a context the
   contract does not type was the alternative and was rejected;
   `@btravstack/http-server` passes the same signal as its handler's third parameter,
   which is that signal by another route. A transport's own cancellation —
   Temporal's `Context.current().cancellationSignal` — is a **different clock**,
   not this one. A repository pulled from an ambient store is the untestable
   coupling; a
   tenant id read by the Postgres adapter is not. Legitimate readers are
   infrastructure adapters only (logger, OTel exporter, database adapter), and
   the logger is no longer hypothetical: `@btravstack/observability`'s
   `createLogger` — the implementation of the kernel's own `Logger` port —
   reads `currentUnit()` **per call** and stamps `unitId` /
   `traceId` / `tenantId` on every line, so an application writes
   `logger.info("placing an order", { orderId, quantity })` and mentions
   correlation nowhere. Per call, not at construction, is the load-bearing
   half — one logger is built per scope and every unit has its own record.
   Application code reading the store is meant to be a lint error, in the spirit
   of `unthrown/no-catch-all-pattern` stating unthrown's own default. **That
   rule does not exist yet** — it needs a way to identify an adapter, a
   convention this stack has not established — so today it is a documented
   convention with no enforcement. Do not describe it as enforced.

   **A transaction is not on the record either, and that is the decision, not
   an omission.** Commit boundaries belong to the **adapter**, spelled
   explicitly at the call — `examples/order-infrastructure`'s
   `prismaOrderRepository` already does exactly this: `save` writes the order
   row and its outbox row inside one `db.$tryTransaction`, and `remove` does
   the same for the tombstone, with `@unthrown/prisma` supplying the
   primitive. Nothing is hand-rolling a missing framework feature there.
   Cross-store atomicity is the **outbox** plus a **saga**, which is what the
   three examples are built on. Three reasons a unit-scoped transaction is
   the wrong shape: it makes every request an **interactive** transaction,
   which Prisma's own documentation says to reach for last; the unit does not
   close until the response is **flushed** (the first contract a runtime
   owes), so a pooled connection would stay pinned while bytes go to the
   client; and a **port does not say where its data lives**, so a boundary
   drawn around a unit spans stores the framework cannot see inside — a
   promise it has no way to keep. Nested and joined transactions follow from
   this: not supported, and not a framework concept.

3. **The kernel never maps an outcome to a transport.** `Result` → HTTP status
   belongs to the router an application hands `@btravstack/http-server`
   (oRPC's `.result()` triage) — the package itself declines that mapping,
   deliberately — `Result` → activity failure to `@btravstack/temporal-worker`, likewise. `@btravstack/amqp-worker`
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

   **Declining the mapping is not declining the help — the help is the `Err`
   channel's own type** (issue #69's question, answered by measurement).
   `placeOrder`'s union (`InvalidQuantity | InvalidOrderId | DuplicateOrder`)
   has one source of truth — the `PlaceOrder` port in
   `examples/order-application/src/ports.ts`, which the interactor's return
   type is checked against — and flows through the port
   to every consumer; each triage site folds it with an exhaustive
   `mapErrCases` (`P._` is a lint error, and its two structural disables are
   nowhere near a triage), so widening the union fails
   **every** site in one `pnpm typecheck` run — the compiler's failure list
   IS the site list, and no hand-kept registry ties the copies together.
   The `InvalidOrderId` arm is the worked proof: adding it broke both sites,
   both grew their arm, and the one surface that drifted — narrative docs —
   is what the doc-samples gate now compiles. That union has exactly **two**
   runtime triage sites in the running examples — `examples/order-api`'s
   orders controller (→ `CONFLICT` /
   `BAD_REQUEST` / `INVALID_QUANTITY`) and `examples/order-temporal-worker`'s
   fulfillment activities (→ `nonRetryable` contract errors); the copies the
   documentation shows are mirrors of these two, held to the same compile by
   the doc-samples gate, so they sit in the same failure list — and the AMQP
   worker is deliberately not a third: a subscriber reacts to a committed
   fact, so a placement's `Err` never reaches it, and the ack/retry/DLQ split
   its `CLAUDE.md` describes triages the handler's OWN failures, a different
   class. A cross-transport triage helper was sketched and declined: the
   destinations' types are each contract's own (`errors.CONFLICT` is oRPC's
   constructor, `errors.OrderAlreadyPlaced` temporal-contract's), so a shared
   mapper either erases them or becomes a per-transport registry restating
   what `mapErrCases` already enforces — a checklist in fancier clothes. A
   new consumer of the port is a new site, and it arrives carrying the same
   obligation from its first compile.

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
`@btravstack/http-server`'s `closedOf` checks `response.closed` for exactly this,
found by a client hanging up during a slow per-request acquire and leaving a
unit open for the process lifetime.

## Cross-cutting concerns: configuration, not a middleware slot

CORS, body limits, compression, CSRF, security headers and authentication all
arrive at the same door, and the answer is the same for all of them: **they are
handler configuration, not a middleware slot.** Thesis #3's refusal survives
intact, narrowed to what it was always about. An oRPC plugin and the starter's
own `principalMiddleware` act on the **request/response envelope** — bytes,
headers, a principal resolved before dispatch. An application middleware would
act on the handler's **`Result`**, and that is the only one `@btravstack/http-server`
refuses, because it is the one that would put a use case's outcome in the
transport's hands.

- **`plugins` is an honest escape hatch, not a keyhole.** It forwards straight
  to `new RPCHandler(service, { plugins })`, and an oRPC plugin can reach
  oRPC's interceptors — so an application determined to see a procedure's
  outcome can get there. Nothing pretends otherwise. What the option buys is
  that the ordinary path is configuration a reader can see at the composition
  root, and reaching past it is a visible act rather than the default shape.
- **Security headers are set on the listener, not as a plugin.** A plugin only
  runs for a request oRPC **matched**, so the runtime's own `404` would go out
  bare — the opposite of what helmet-style headers are for.
- **Rate limiting is a stated non-goal.** A per-process counter is the wrong
  unit: an `api` deployment is N pods (thesis #1), so a per-process budget is
  N independent budgets and none of them is the limit anybody meant. The
  ingress or gateway is where a request count is counted once. An application
  that wants one anyway writes a plugin and passes it through `plugins` —
  which is the escape hatch doing its job, not a gap.
- **An unmarked procedure is public, and nothing fails if the marker is
  forgotten.** `@btravstack/contract`'s marker makes the requirement
  **legible** in the contract and makes the principal's type reach the
  handler; it does not detect a procedure that should have been marked. There
  is no gate for "you forgot", and there cannot be one — the contract is the
  only statement of intent there is. Do not describe an unmarked procedure as
  checked.
- **Authorization is deliberately not in the contract.** "May this caller do
  this?" often depends on the resource — the order's owner, its state, the
  row's tenant — which cannot be answered before the handler has run and
  fetched it. Putting the caller-shaped half in the contract and leaving the
  resource-shaped half in the handler splits one rule across two files, and
  the half in the contract is the half that looks complete. Authentication —
  "is there a principal, and what is it?" — is answerable before dispatch, and
  is the only half the contract carries.

  A **scope** is the exception that proves the rule, and it is admitted on the
  same test: it is a property of the credential, answerable before dispatch,
  which is exactly why authentication is in the contract already. What stays
  out is resource-dependent authorization — the order's owner, the row's tenant
  — which a scope was never going to answer. `@btravstack/http-server` checks a
  credential's granted scopes against the endpoint's declared ones and answers
  `403`, distinct from the `401` a caller with no valid credential gets.

## Public surface

Each package's surface is stated **once**, in that package's own `CLAUDE.md`,
and again for a reader on the documentation site. It is deliberately **not**
restated here: this file used to carry a copy, and the copy drifted — it
described `Logger.error`/`fatal` as taking `(message, cause?, attributes?)`
while `logger.ts` shipped `(message, attributes?, cause?)` on all six methods
_and argued for that ordering in its own TSDoc_. Five copies, one gate, and
the copy with no gate is the one that lies.

| Package                       | Surface lives in                     | Reference page               |
| ----------------------------- | ------------------------------------ | ---------------------------- |
| `@btravstack/contract`        | `packages/contract/CLAUDE.md`        | `/reference/contract`        |
| `@btravstack/di`              | `packages/di/CLAUDE.md`              | `/reference/di/`             |
| `@btravstack/config`          | `packages/config/CLAUDE.md`          | `/reference/config`          |
| `@btravstack/core`            | `packages/core/CLAUDE.md`            | `/reference/core/`           |
| `@btravstack/testing`         | `packages/testing/CLAUDE.md`         | `/reference/testing`         |
| `@btravstack/observability`   | `packages/observability/CLAUDE.md`   | `/reference/observability`   |
| `@btravstack/cache`           | `packages/cache/CLAUDE.md`           | `/reference/cache`           |
| `@btravstack/mailer`          | `packages/mailer/CLAUDE.md`          | `/reference/mailer`          |
| `@btravstack/storage`         | `packages/storage/CLAUDE.md`         | `/reference/storage`         |
| `@btravstack/http-server`     | `packages/http-server/CLAUDE.md`     | `/reference/http-server`     |
| `@btravstack/temporal-worker` | `packages/temporal-worker/CLAUDE.md` | `/reference/temporal-worker` |
| `@btravstack/amqp-worker`     | `packages/amqp-worker/CLAUDE.md`     | `/reference/amqp-worker`     |

**Three ports are declared in `@btravstack/core` and implemented elsewhere:
`Logger`, `Tracer` and `Meter`.** That is the one place the table's
"surface lives in" column splits from "who ships the behaviour", and it is
deliberate: a contract that other framework packages depend on has to be
reachable without installing an implementation, and `core` is the package all
of them already peer on — so `@btravstack/cache` can count its hits without
its consumers installing a logging package and an OpenTelemetry SDK to
compile. The tracing pair is declared **without naming OpenTelemetry**, as a
narrowing its real types satisfy structurally, so the vendor stops at
`@btravstack/observability/otel`. Their detailed home is
`packages/core/CLAUDE.md` and `/reference/core/observability`.

What stays here is what no single package owns: the theses above, the footgun,
the two contracts a runtime owes, and the conventions below.

`packages/core/src/index.ts` is the one place the kernel's API is decided —
one entry point. The test doubles are `@btravstack/testing`, a package of its
own that peers on the kernel (the `@nestjs/testing` shape), so a production
bundle never pulls the fakes in and the kernel ships none.

There is **no** `Defect` construction, no accumulation
of runtimes, and no `recoverFailure`-style channel-moving helper. Swapping an
adapter is composing a different module, which di already documents and the
type checker already verifies — in **production**. The testing half of that
sentence changed in issue #63: `@btravstack/testing`'s `overridden(module,
[providers])` substitutes named providers into the real root (di's
`overrideProvider` is its primitive — the one deliberately test-facing export
in di's surface), because the alternative was four hand-maintained parallel
roots in `examples/` that mirrored the real ones and drifted silently. An
override the root stops backing is a `WiringDefect` ("nothing to override"),
so the mirror is now held mechanically. Production composition roots stay
override-free by convention; a root that reaches for `overrideProvider` is
recomposing the lazy way. And an override replaces one **provider**, never a
subsystem: the replaced provider's siblings still construct, so swapping a
whole adapter stack — or a graph whose SHAPE varies per test, like the
temporal fixture's per-queue contract — remains a different module composed
in its place.

## Toolchain & conventions

- **`examples/` is part of the gate, not a folder of illustrations.** All
  ten workspaces run under the same six commands as the kernel — their specs
  plus four `needs-gate.test-d.ts` files, four `layering.test-d.ts` ones and
  `hexagonal-order-api`'s `index.test-d.ts` —
  so an example that stops compiling, stops linting or stops passing fails CI
  exactly as `packages/core` would. Three of the four needs-gate files pin
  **`start`'s** gate (`order-api`, `order-temporal-worker`,
  `order-amqp-worker` — its `NO RUNTIME` arm, since no starter's runtime
  resolves anything any more; `order-api`'s also pins the `unit` halves) and
  the **unmet need** on the starter's port (a composition importing `http()` /
  `temporal({ contract, workflows })` / `amqp({ contract })` without providing
  the router / activities / handlers carries the starter's port in `Needs`, and
  `start`'s `module` parameter takes only `Scope | Env`, so it fails to assign —
  the starter is an IMPORT, and an import's needs travel without the importer
  re-declaring them, so di's declaration gate has nothing to say and this stays
  the kernel's); the fourth, `order-application`'s, pins **di's**
  `UNSATISFIED DEPENDENCIES` gate on `Module.scoped` — `DependencyGate`, a
  marker on the `module` parameter since issue #93, whose message ends on the
  missing ports:
  `'{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": Logger | OrderRepository; }'`
  (it was a rest-tuple arity error printing `Expected 5 arguments, but got 2`
  and nothing else).
  A **fourth** mechanism joined them in #50 and is pinned beside the third:
  di's `NeedsGate`, which fires when a module's OWN provider reads a port
  nothing local satisfies and `needs` does not name it —
  `order-temporal-worker`'s `FulfillmentlessSlice`, printing
  `'{ readonly "UNDECLARED NEEDS — name it in `needs`": StockService | ShippingService; }'`.
  **Four** mechanisms, easy to conflate — and since #93 every one of them
  prints a name. Do not call the second "di's `UNSATISFIED DEPENDENCIES` gate": an
  earlier revision of this file did, and it is wrong in both halves. `start`'s
  `UNSATISFIED RUNTIME PORTS` arm is pinned only by `packages/core`'s own
  `start.test-d.ts`, since every shipped runtime declares `resolves: []`.
  `examples/` is not the only place the gate is pinned by a **type test**:
  `packages/amqp-worker/src/amqp-runtime.test-d.ts` pins the handlers-port half of
  `amqp`'s own gate, and its sibling `packages/amqp-worker/src/handler.test-d.ts` pins
  the composing form's — a piece typed by the one key it names, and the root's
  array refused when it misses a declared key. `packages/temporal-worker/src/workflow-activities.test-d.ts`
  pins the same shape for `temporal`'s composing form and is that package's
  **first** type test — `packages/temporal-worker` had no `*.test-d.ts` file, and no
  `tsconfig.test-d.json` or `test:types` script, before it. `packages/http-server/src/controller.test-d.ts`
  pins the
  five compile-time gates the keyed `HttpRouter(contract)(controllers)` form
  owes (see `packages/http-server/CLAUDE.md`). `@btravstack/http-server`'s 50 specs, across
  `http-runtime.spec.ts`, `orpc.spec.ts`, `controller.spec.ts` and
  `auth.spec.ts`, drive the
  transport through the internal `httpModule` with a bare listener, the
  starter proper through `HttpModule`, the keyed router form through the
  `rpcSliced` fixture, and the contract marker's runtime half — the per-scheme
  authenticator ports and the one middleware they install — through
  `rpcAuthed`. **The contract says WHICH SCHEMES protect a route, and which
  scopes each must grant; the application's `defineHttp({ authenticators })`
  says WHAT each scheme resolves to.**
  `@btravstack/contract` names no identity type at all — `authenticated` takes
  OpenAPI requirements and no type parameter — so nothing about a server's
  view of a caller reaches a client, and a marked fragment reached through
  anything but that one call types `principal: never`, which makes every read a
  compile error and is the signal to use the factory.
  `examples/order-api/src/auth.ts` is the one file per application that names
  its identities, and there is no identity comparison left to make: declaring a
  scheme and implementing it are the same act, so a scheme the contract names
  with no authenticator behind it is di's own unmet need on
  `HttpAuthenticator:<scheme>`. The one call's result is held as **one
  binding and never destructured** — each destructured member expands to a type
  mentioning `@btravstack/contract`'s inaccessible `unique symbol` (TS2527),
  while held whole it collapses to the nameable `Http<A>`, which is why the
  application writes no type annotation at all.
- **The local loop is `pnpm dev`, and it is the production shape** (issue
  #67): `turbo run dev --filter=./examples/*`, one process per deployment,
  each `tsx watch --env-file=../../.env.dev src/main.ts`, output prefixed by
  workspace. The reasoning against a one-process runner is in thesis #1; what
  lives here is the mechanics.
  - **`tsx`, because Node alone cannot run these files.** Relative imports
    carry `.js` (`moduleResolution: NodeNext`) and Node's own type stripping
    does not remap `./module.js` to `./module.ts` — measured, it is an
    `ERR_MODULE_NOT_FOUND`. `tsx` was already in the catalog for `docs`; it is
    a devDependency of the three example workspaces, and no new dependency.
  - **`.env.dev` is generated, never committed.** The `dev` task depends on
    `@btravstack/internal-test-infra#dev:env`, which attaches to the **same
    six shared containers the specs use** (`withReuse()` — a second set
    would be issue #52's duplication in another hat), runs
    `prisma migrate deploy` under the same lock as the example's own
    `globalSetup`, and writes `DATABASE_URL` / `AMQP_URL` /
    `TEMPORAL_ADDRESS` / `REDIS_URL` / `SMTP_URL` / the four `STORAGE_S3_*`. They are written to a file rather than defaulted
    because the ports are whatever Docker mapped, and an ephemeral mapped
    port cannot be a default. `--env-file` is Node's own; no `dotenv`.
  - **`PROBE_PORT` is per app, inline in each `dev` script** (`9000`, `9001`,
    `9002`): it defaults to `9000` for every application, so on one machine
    two of the three fail with `RuntimeStartFailed` for `"probes"`. That is
    the kernel reporting an `EADDRINUSE` correctly — in production each pod
    has the port to itself — and it is why per-app values live in the per-app
    script while shared ones live in `.env.dev`.
  - **`tsx watch` force-kills its child 5 s after a signal**, so a Ctrl-C
    under the watcher can cut beat 3 short — the kernel's own defaults are
    `preDrainDelayMs: 5_000` then up to `drainTimeoutMs: 20_000`. To watch a
    real drain, run the entry point without `watch`. Measured end to end:
    `draining` → `drained` exactly 5.002 s later → `stopping` → `exited 0`.
  - **The root `dev` script is filtered for a reason.** Sixteen workspaces
    have a `dev` script (twelve packages' watch-builds, `docs`, three examples),
    and turbo refuses more persistent tasks than its concurrency — so the
    unfiltered `turbo run dev` the root carried was **already broken** before
    this, failing on ten persistent tasks against a concurrency of ten.
- **The whole gate runs on SIX containers, shared, and `internal/test-infra`
  owns them.** One `postgres:18.1`, one `rabbitmq:4.2.1-management-alpine`,
  one `temporalio/auto-setup:1.29.1`, one `redis:8.8.2-alpine`, one
  `axllent/mailpit:v1.31.0` and one `rustfs/rustfs:1.0.0-rc.3`, started
  once per machine and reused by
  every workspace's vitest run **and by `pnpm dev`**. Nine workspaces need a Docker daemon —
  `packages/amqp-worker`, `packages/temporal-worker`, `packages/cache`, `packages/mailer`,
  `packages/storage`, and the four
  `examples/` that boot the
  application or a broker-backed runtime — and that is a fact a contributor
  discovers the hard way unless a README says so, which is why each one's
  does. Measured on this machine: `pnpm test` at turbo's default concurrency,
  **27/27, ~32 s warm** (before `packages/cache` joined; the Redis container
  is the cheapest of the four to start).

  It used to be **five servers for those six workspaces** — a RabbitMQ
  container per AMQP vitest run and a Temporal time-skipping server per
  Temporal vitest _worker_ — and `pnpm test` was intermittently red because
  the 60 s testcontainers startup wait was what gave out first, with the
  failing workspace moving between runs (issue #52). Nothing about that was a
  missing isolation boundary; each system already had one finer than "a server
  of my own", and only the server was duplicated:
  - **a vhost per test**, minted by `@amqp-contract/testing`'s `it` extension
    from the management API — untouched by this;
  - **a namespace per spec file**, registered by
    `@btravstack/internal-test-infra/namespace`, which then polls a
    namespace-scoped read until every Temporal service's registry has caught
    up (`describeNamespace` answers from the frontend alone and is not
    enough). Per file, not per test: registration costs that refresh, and a
    task queue per test — which both suites already mint — separates the tests
    inside one file;
  - **a tenant per test**, which is what the example application being
    multi-tenant buys (see below);
  - **a key prefix per test**, which is what a Redis suite mints — finer than
    a database index, and free;
  - **a recipient per test**, which is what a mail suite mints — Mailpit
    delivers nowhere and keeps everything, so a UUID localpart is a mailbox
    nobody else reads;
  - **a key prefix per test** again for object storage, inside ONE bucket: a
    bucket per test would be a create-and-delete round trip bought for an
    isolation a UUID prefix already gives for nothing.

  `withReuse()` is what makes the second, third and fourth workspace attach
  instead of start. Two consequences are deliberate and stated in
  `internal/test-infra/README.md`: a reused container is **not** registered
  with Ryuk, so it outlives the run (`docker rm -f $(docker ps -aq --filter
label=com.btravstack.test-infra)` clears them), and testcontainers' own reuse
  lock is **in-process**, which does nothing about turbo starting several runs
  at the same instant — a `mkdir`-based file lock under `<repo>/.cache/`
  closes that race.

  Two `globalSetup` modules replace the upstream ones
  (`@amqp-contract/testing/global-setup`,
  `@temporal-contract/testing/global-setup`) by providing the **same** inject
  keys, so both upstream `it` extensions keep working unchanged. The
  time-skipping test server is gone with them: neither Temporal suite ever
  advanced a clock, so the skippable clock bought nothing a private namespace
  does not — and with it went the one workspace that needed the **network** on
  a cold cache, and the CI cache gap that came with it.

- **The example application is multi-tenant, and that is why one database
  serves the whole gate.** `examples/order-infrastructure` is PostgreSQL on
  the shared server — a database of its own next to Temporal's — migrated once
  per run by `src/global-setup.ts` with **`prisma migrate deploy`**, the
  command a deployment runs, under the same cross-process lock. Nothing is
  truncated or dropped between tests: each test declares a **tenant** of its
  own (a UUID), so a shared database costs one migration for the whole gate
  instead of one per test, and no test can see another's rows whatever order
  they run in.

  It replaced SQLite **in memory**, which was the right call while every test
  built its own database and stopped being one the moment the gate needed a
  PostgreSQL for Temporal anyway.

  **The tenancy is the APPLICATION's, and the framework has no concept of
  one.** Every port names its tenant — `OrderRepository.find(tenantId, id)`,
  `PlaceOrder.execute(tenantId, id, quantity)` — and each transport supplies it
  from its own **contract**: an input field on `order-api`'s **unmarked**
  `customers` procedures — the marked `orders` half names none, because an
  authenticated caller's own principal establishes it — a field on the AMQP
  envelope, and a field on every Temporal workflow and activity input. No
  starter reads a tenant off anything.

  That line was drawn deliberately, and an earlier revision of this file
  described the opposite. A tenant is _context_, and what establishes it — a
  header, a subdomain, an authenticated subject — is a decision about a
  specific system, as is what happens when it is missing. A starter with a
  `tenantOf` hook decides both on the application's behalf and is the first
  step of a framework tenancy model that owes many more answers than that one.
  `UnitRecord.tenantId` stays what it always was: a field for a **hand-rolled**
  runtime whose author has already answered them, set by no shipped starter.

  **The tenant is branded, and the ids beside it are branded on the answer
  side only** (`TenantId` in
  `examples/order-domain/src/tenant.ts`, a `z.uuidv7().brand("TenantId")`).
  Two strings in a fixed order are what the compiler has nothing to say about,
  so `find(id, tenantId)` compiled and queried the wrong tenant; a pair need
  differ in ONE position to become unswappable, which is why branding every id
  was a separate question — answered separately, in issue #80: **error
  payloads and outputs carry the id's brand, inputs never do.** The domain's
  errors declare `id: OrderId` / `CustomerId` (except the two "as received"
  ids — `InvalidOrderId`'s, which by definition is not one, and the
  contracts' `malformedRef`), and the contracts' refs and views brand their
  `id` slots with the same brand keys, so a customers ref in an orders slot —
  shipped twice in one day, #76 and #77 — is a compile error at the
  controller now. A caller's ergonomics are untouched: the fiction is asked
  only of the server, and a port's `id: string` parameters stay bare, claimed
  by a cast where the error is minted — the same once-per-boundary rule the
  tenant follows. The constructor is a **cast, not a
  parse** — `.parse()` throws, and the value arrived through a contract that
  already validated it — so each path claims the brand exactly once, where an
  outside value becomes the application's vocabulary: the API's
  `bearerAuthenticator` (from there the `Identity` carries it and neither
  controller casts), the customers controller's `TenantId(input.tenantId)`,
  each Temporal activity's `TenantId(args.tenantId)`, and the relay's
  `tenantsOf`, which brands the `OUTBOX_TENANTS` list once at the config
  boundary. The AMQP handlers cast nothing: neither calls a port that names a
  tenant, so there is no boundary there to claim. `prisma-outbox.ts` is the
  one **read-back** — a row becoming an `OrderEvent` — and so the one place
  the brand is re-applied rather than carried.

  **Every id beside it is a UUIDv7**, declared once on the entity
  (`OrderId`, `CustomerId`) and again on each contract's own schema, so a
  malformed id is refused at the transport before a use case sees it. That
  format is what gave `placeOrder` a **second** way to fail: while the id was
  an unconstrained string the quantity was the only field a typed caller could
  get wrong, so collapsing `Order.make`'s `InvalidEntity` to `InvalidQuantity`
  was sound; with a format it became a mislabelling, and `InvalidOrderId` is
  the arm that fixes it. The two are told apart by **which field** the entity
  named — `Entity.keysOf` over the issue's path — never by the message text,
  and each transport now carries a third arm for it: `BAD_REQUEST` over HTTP,
  a `nonRetryable` `InvalidOrderId` on Temporal, a `NonRetryableError` on the
  queue.

  Two things fall out of making it an argument, and they are the reason rather
  than the price. A caller that forgets its tenant **does not compile**, where
  an ambient one fails at runtime or silently reads another tenant's rows —
  and because the tenant is branded and the id beside it is not, neither does
  a caller that **swaps** them, which is the failure issue #81 named:
  `find(id, tenantId)` type-checked and queried the wrong tenant. And
  a test needs no machinery at all — no fixture that "enters" a tenant, no
  store to set — which is why the persistence specs read
  `repository.find(tenant, "0199a1e0-0000-7000-8000-000000000001")`.

  **A cache key carries the tenant, and that is the same rule one layer
  out.** `@btravstack/cache`'s `Cache` takes plain string keys — no namespace
  parameter, no tenant slot — because a cache is an application service and
  the framework has no concept of a tenant to put there. So
  `examples/order-api`'s customers controller composes
  `customers:{tenantId}:{id}` by hand, which is the one place the discipline
  is spelled rather than typed: a port states it in its signature, a string
  key cannot, and the test that proves the read-through reads under a tenant
  of its own for exactly that reason.

  `Outbox.pending(tenantId, limit)` is the case that shows ambient could not
  have covered this anyway: the relay reading it is a background sweep with no
  request, delivery or activity behind it, so there is nothing to read a tenant
  from. Which tenants it serves is deployment configuration
  (`OUTBOX_TENANTS`), and it sweeps tenant by tenant so one tenant's backlog
  cannot starve another's.

- **The Prisma client is generated at test time, and there is nothing to
  install.** `@btravstack/example-order-infrastructure`'s `generate`
  script writes a gitignored client into `src/generated`, and turbo's `test` /
  `typecheck` / `test:types` tasks carry **both** a `generate` and a
  `^generate` edge — the first so the workspace's own client exists, the second
  so a dependent workspace gets one too. The scripts themselves do **not** call
  `prisma generate`: they did until 2026-08-13, and on a cold cache turbo ran
  the `generate` task and the script's inline copy **concurrently**, which
  fails with `EEXIST: mkdir …/generated/prisma/models`. One generator, ordered
  by the task graph, is what makes that impossible rather than rare.
- **An integration test may boot its real dependency with Docker and
  testcontainers.** A suite that needs a broker, a database or a service starts
  one; there is no rule against a daemon, and a hand-written double that fakes
  the thing under test would prove less than the container does. What is still
  true is the preference underneath: reach for the cheapest fixture that tests
  the real behaviour, and **share** the one you reach for rather than starting
  a copy per workspace — a vhost, a namespace or a tenant is a cheaper
  boundary than a server, and it is the boundary the system under test
  actually has. State the cost in the workspace's README, since a suite that
  needs a daemon is a fact a contributor discovers the hard way otherwise.
- **`examples/order-temporal-worker` consumes `@btravstack/temporal-worker`**, the same
  way `order-api` consumes `@btravstack/http-server`: it supplies the contract, the
  activities provider and the `mapErrCases` triage, and reads `{ taskQueue,
namespace }` back off `Serving.info`. The Worker's lifecycle, the unit per
  attempt and the deadline race are the package's. It is a **two-slice
  modulith**: `FulfillmentSlice`'s `fulfillOrder = TemporalWorkflowActivities(orderContract,
"fulfillOrder")({ place: PlaceOrder, repository: OrderRepository, stock: StockService,
shipping: ShippingService }, { sync })` and `BillingSlice`'s `chargeOrder = TemporalWorkflowActivities(orderContract,
"chargeOrder")({ payments: PaymentService }, { sync })` are each a **piece** — a provider
  on the port its own contract key mints, closing over only the services its
  own saga calls, no context read at call time — and the root composes them,
  `orderActivities = TemporalActivities(orderContract)([fulfillOrder,
chargeOrder])`, into the composition root
  `TemporalModule("OrderTemporalWorker")({ contract, activities:
orderActivities, workflows, imports: [FulfillmentSlice, BillingSlice,
observability(), otel()], exports: [Tracer] })`, the sugar importing the starter. `FulfillmentSlice`
  imports the orders vertical (`OrderApplicationModule` +
  `OrderPersistenceModule`) plus `FulfillmentModule`; `BillingSlice` imports
  `BillingModule` alone — the two verticals meet only in that `imports` list,
  never inside either slice's own graph. The connection and `TEMPORAL_*` come
  from the starter, and `LOG_LEVEL` and the `Logger` the sagas' stand-in
  services write to come from `observability()`. `order-amqp-worker` is the
  same shape — `NotificationsSlice`'s `orderNotifications = AmqpHandler(orderContract,
"orderNotifications")({ logger: Logger }, { sync })` and `AuditSlice`'s `orderAudit =
AmqpHandler(orderContract, "orderAudit")({ logger: Logger }, { sync })`, composed as
  `orderHandlers = AmqpHandlers(orderContract)([orderNotifications,
orderAudit])` — but **neither** slice imports a vertical: a subscriber reacts
  to a fact somebody else already committed, so the orders vertical stays at
  the root, next to the outbox relay that writes it
  (`AmqpModule("OrderAmqpWorker")({ contract, handlers: orderHandlers,
imports: [OrderApplicationModule, OrderPersistenceModule, NotificationsSlice,
AuditSlice, observability(), otel()], … })`),
  with its outbox relay a resourceful provider of its own rather than
  something layered onto the runtime — the relay is also the one place in the
  examples that logs a **failure**, `logger.error(message, cause, { eventId })`
  down each of its three arms. Both are also where **honouring the
  kernel's deadline through the ambient record** is worked: neither middleware
  injects anything into the call — `next()` unchanged — so
  `currentUnit()?.signal` is the only route to it, and what each piece answers
  when it is aborted is that **slice's own** business now: `order-amqp-worker`'s
  `orderNotifications` returns a `RetryableError`, leaving the delivery
  un-acked so the broker hands it to the next worker, while `orderAudit` keeps
  writing through the drain window rather than leaving a delivery un-acked;
  `order-temporal-worker`'s `ShippingService.arrange` fails as a **defect**,
  which the platform retries on another worker — the contract's
  `ShippingUnavailable` is a permanent no and would be the wrong error for "we
  ran out of time".
- **A piece is a provider; a slice is a module; a modulith is several slice
  modules in one root — one shape, all three transports.** No new concept: a
  slice owns its own piece of the surface — an HTTP fragment and controller, a
  Temporal workflow and its activities, an AMQP consumer and its handler — and
  (if it needs one) its own adapter, and ships as an ordinary di `Module` that
  exports only that piece's port — everything else about the slice stays
  private. It also **declares what its own providers expect from the
  root**, in `needs`: `AuditSlice` is `needs: [Logger]` because its handler
  reads one, `OrdersSlice` is `needs: [Logger]` because its controller does,
  and a slice whose provider owed a port and named none does not compile (#50,
  di's `NeedsGate` — the full rule is in `packages/di/CLAUDE.md`). An
  **import's** needs are not restated: `OrdersSlice` says nothing about `Env`,
  because the module that reads `DATABASE_URL` is `DatabaseModule` and it says
  so there. That is what makes a slice directory readable on its own — which
  ports come from outside, without naming who supplies them — and what keeps a
  `needs` list one line per feature instead of one per hop. `@btravstack/http-server`'s
  `api.HttpController(name, fragment)({ name: Dep }, { sync })` mints the controller's
  port — `api` being the application's one `defineHttp(...)` binding; the root
  composes every slice's controller into one router with the
  keyed `api.HttpRouter(contract)(controllers)` form, exact against the contract
  (see `packages/http-server/CLAUDE.md`). **A fragment is itself a valid contract**,
  so a slice lifts out of the modulith into a process of its own without its
  controller changing at all: the lifted root is
  `api.HttpRouter(contract.orders)({ implementation: ordersController.port }, { sync: ({ implementation }) => implementation })`,
  declaring the very provider the modulith composed and handing back what it
  built — a new composition root and one fewer import,
  not a rewrite of the slice. That exact call is `controller.test-d.ts`'s fifth
  gate, deliberately naming the controller: a fresh `sync` over the fragment
  would pin only the weaker "a fragment is a valid contract" half. This is what
  makes composing several slices into one router a starting point rather than a
  trap, and it is the one property marked do-not-break in the design.

  A worker's record is not nested by fragment the way HTTP's contract is —
  there is nothing shaped like `HttpRouter`'s record to key a composition by —
  so its starter composes an **array** of pieces instead. `@btravstack/amqp-worker`'s
  `AmqpHandler(contract, key)` and `@btravstack/temporal-worker`'s
  `TemporalWorkflowActivities(contract, key)` each mint one piece straight
  from the contract key — a consumer or a workflow, with the key carried on
  the piece's own port id rather than on a record position — and
  `AmqpHandlers(contract)([...])` / `TemporalActivities(contract)([...])`
  compose them: every key the contract declares must be covered (an uncovered
  one is refused at the call, against an `"UNCOVERED HANDLERS — …"` /
  `"UNCOVERED ACTIVITIES — …"` marker — at the **tail of the third line** of a
  `TS2769`, past three hundred characters of the caller's own contract, which
  is not shortenable from inside either package because the width is in the
  type arguments rather than in a name; the missing key is named too once the
  array's length matches the marker tuple's own length of 2, as a **separate**
  diagnostic on the trailing element whose target is the bare key), and two slices
  both discharged for one key are di's duplicate-provider defect at build —
  the same exactness the keyed HTTP
  form gets from the shape of the record it composes, reached here through the
  port id instead, because there is no record to be exact against. See
  `packages/amqp-worker/CLAUDE.md` and `packages/temporal-worker/CLAUDE.md` for the full
  surface, and `docs/how-to/split-a-worker-into-slices.md` for the task — the
  sibling of `controller.test-d.ts`'s do-not-break property above does not
  exist on this side: a worker's array has no lifted-fragment form to
  preserve, since a piece already IS one contract key on its own.

- **`examples/order-api` consumes `@btravstack/http-server` rather than
  hand-rolling a transport, and its HTTP stack is the package's ONE way: oRPC
  over its own node adapter, `@unthrown/orpc` at the boundary.** It is a
  two-slice modulith on the shape above: `slices/orders/` and
  `slices/customers/`, each its own contract fragment, its own
  `HttpController` and its own di module — which **imports the vertical it
  needs** (`OrderApplicationModule` + `OrderPersistenceModule`,
  `CustomerApplicationModule` + `CustomerPersistenceModule`) and exports only
  its controller, in di's provider form (`exports: [ordersController]`, since
  `HttpController` mints the port and there is no class to name; the two
  slices are that form's first call sites). One module per vertical in **both**
  layers, not one per layer: a slice, and each worker, carries its own
  vertical and none of the other's. What the slices still share is the
  internal `DatabaseModule` both persistence modules import: a diamond, not
  duplication, since `build.ts`'s `flatten` collapses the tree into a `Set`
  keyed by provider **reference** — measured on this composition, a naive walk
  visits 16 provider slots and di keeps 15, one `OrderDatabase` among them
  (the same walk over the pre-split modules visited 22 for the same 15, and
  the difference is the over-inclusion the split removed). The root composes them —
  `orderRouter = api.HttpRouter(contract)({ orders: ordersController,
customers: customersController })`, the keyed form — and
  **`HttpModule("OrderApi")({ router: orderRouter, imports: [OrdersSlice,
CustomersSlice, observability(), otel()], exports: [Logger, Tracer, Meter] })`** is the whole
  composition root, a list of slices plus what no slice owns — the
  sugar imports `http()`, provides the router on the starter's
  `HttpRouterPort` and
  exports `HttpRuntime`: `OrderApi` is a constant, `PORT`/`HOST`, `DATABASE_URL` and `REDIS_URL` come from the
  environment inside the graph, and the router is mounted under `/rpc`. The
  two authenticators are **not** in that list: they ride the router, which is
  what needs them, and `HttpModule` puts them in `provides` itself. The
  **unmarked** `customers` fragment declares `tenantId` on its input, so a
  procedure hands it to the use case and the use case to the repository; the
  **marked** `orders` fragment declares none and its handlers read
  `context.principal.tenantId` instead — a caller does not name the tenant it
  is served, and a required field the handler ignores would be a confused
  deputy in contract form. Either way the transport reads nothing about
  tenancy.
  `observability()` is what provides the `Logger` the interactors and the
  request scope write to, and `Logger` is in `exports` because `RequestModule`
  reads it out of the application scope. `RequestModule` rides
  `StartOptions.unit` so
  the per-request fork is the kernel's. There is no `runtime`, `resolves`,
  `handler`, `port` or env-reading to spell anywhere. Its `main.ts` passes
  `onEvent: kernelEvents(createLogger(jsonSink()))` so the kernel's nine events
  land in the application's own stream, with the logger built by hand because
  `building` is emitted while the graph still is — the kernel's stderr sink
  is a fine default and this is the upgrade, not the requirement. All three
  `main.ts` files pass a unit module since the examples were instrumented
  with the trio: `RequestModule` here (which imports `UnitSpanModule` and
  records a request-duration histogram beside the finish line it logs), bare
  `UnitSpanModule` on the two workers — so every unit, request or delivery
  or activity attempt, opens an OTel span carrying the same ids the logger
  stamps, and the roots compose `otel()` beside `observability()` and export
  its ports for the fork to read. Each metric sits at an adapter seam, never
  in the application layer: the request span's histogram, the outbox relay's
  per-tenant `relayed` counter, the billing stand-in's `authorized` counter. Each procedure is a plain
  `Result`-returning function typed by its slice's fragment (`@unthrown/orpc`'s
  `.result()` handler, attached inside each `HttpController`). It reads
  `port` back off
  `Serving.info`; binding, the drain and the trace-id policy are the
  package's. Two gates keep the composition honest at compile time: a root
  that forgets `http()` is refused against
  `"NO RUNTIME — the module exports no port declared over RuntimePort"`, the
  sentence intersected onto `start`'s `module` parameter, and one that imports
  it without providing `orderRouter` leaves `HttpRouterPort` in `Needs`, which
  the same parameter refuses by assignability — not di's dependency gate.
- **oRPC is pinned to an exact beta.** `@orpc/{client,contract,server}` sit at
  `2.0.0-beta.28` in the catalog because oRPC v2's `latest` dist-tag is still
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
  identity and unthrown's `isResult` each compare across copies). `@btravstack/http-server`
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
  `unthrown` and depends on nothing; `contract` depends on nothing at all, not
  even `unthrown`; `config` peers on `di` and `unthrown`;
  `core` peers on all three; `testing` peers on all four (and not on
  `vitest` — `bootFixture` is a plain function in vitest's fixture shape);
  `observability` peers on all four too and has **no runtime dependency of its
  own** — the default sink is `JSON.stringify` and a `write`; its peer on
  `core` is not optional and cannot be, since the ports it implements are
  declared there. A
  **starter** is the exception by definition:
  `@btravstack/http-server` peers on `@orpc/server`, `@orpc/contract` and
  `@unthrown/orpc` — peers, not dependencies, so an application holds one
  copy of each. **Optional peers behind a subpath** are the family's second
  shape, and `@btravstack/observability`'s `pino` was the first: a consumer
  that never imports `@btravstack/observability/pino` never installs it, and
  the package's own `tsdown` build emits `src/pino.ts` as a second entry
  point for exactly that. `@btravstack/observability/otel` follows it, and
  `@btravstack/cache` now has three subpaths on the same protocol — `redis`
  behind `/redis`, and `@btravstack/observability` + `@opentelemetry/api`
  behind `/instrumented`, so a graph composing the plain `cache()` over the
  memory adapter installs none of them.
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
- `declarationMap: false` on all twelve published packages — the published
  tarball has no `src/`, so maps would be dead ends.
- **Relative imports carry `.js`.** `moduleResolution: NodeNext` plus
  `verbatimModuleSyntax`, both inherited from `@btravstack/tsconfig/base.json` —
  an external package under `node_modules`, so this is the one convention here
  the repo itself cannot show you. `import { x } from "./units"` fails
  `pnpm typecheck` with TS2835.
- All twelve published packages claim `engines: { node: ">=20" }` while the root
  claims `>=22.22`. The divergence is **deliberate**: the root floor is the dev
  toolchain's, a package's is a compatibility promise to consumers. Do not
  align them for tidiness — raising a published floor is a breaking change,
  where raising the root's is a maintenance decision the toolchain forces:
  `engineStrict: true` makes the root floor the highest floor any dev
  dependency declares, so a bump that raises one (`testcontainers@12.1.0`
  wanting `>= 22.22`) moves the root `engines` **and** CI's floor row in the
  same commit, or the install fails on that row.
- **oxlint rules are binding: no `interface` (use `type`), no `any` (use
  `unknown`).** Genuine exceptions carry a targeted `oxlint-disable` **with a
  reason**. Two are structural: `units.ts`'s `UnitWork` return union
  (`prefer-async-result`, a function-type return position) and `run-main.ts`'s
  `P._` (`no-catch-all-pattern`, the generic-`E` case where the catch-all is
  the only arm that can terminate the match).
- The repo dogfoods **every** `@unthrown/oxlint` rule — the six
  `recommended` ones plus both opt-ins (`no-throw`, `no-get-or-throw`). There
  were three
  until `@unthrown/oxlint@5.4.0` removed `prefer-ensure` and `no-throw`; 5.5.0
  restored `no-throw` and kept `prefer-ensure` removed, on the grounds that it
  flagged correct code violating no thesis and carried a known false positive;
  5.6.0 added `no-async-result-race` (issue #92, born from this repo's own
  eager-`AsyncResult` hazard — see the sequencing bullet below), and adopting
  it fired on nothing: the `flatTap`/`DoAsync` discipline was already kept.
  oxlint refuses to parse a config naming an unknown rule, so a config still
  listing a removed rule fails the **whole** lint run, every non-unthrown rule
  included — which is how the 5.5.0 bump surfaced here.
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
- **A passthrough option is typed by the underlying library's own types, or
  it does not exist — a `Record<string, unknown>` bag is banned.** Decided in
  issue #25, where `@btravstack/amqp-worker`'s `connectionOptions` /
  `defaultConsumerOptions` were the family's only untyped bags (twice each —
  the primitive and the `AmqpModule` sugar re-declared them): an `unknown`
  bag cuts against the typesafety pitch, and a key the library ignores was
  silently inert. They now take `@amqp-contract/worker`'s own exported
  `ConsumerOptions` and an `AmqpConnectionOptions` alias reached by index —
  the library declares the type without exporting it, the same trick as
  `AnyAmqpContract` — pinned by `amqp-runtime.test-d.ts`'s passthrough block.
  No starter is obliged to grow a passthrough: `@btravstack/http-server` and
  `@btravstack/temporal-worker` have none, and temporal's named typed options
  (`gracePeriod`, `forceAfter`) are the preferred shape when a handful of
  knobs is all that is wanted — but a passthrough that exists is typed by the
  library it forwards to.
- **Pre-lifted constructors, not `.toAsync()` on a fresh literal.** `OkAsync(v)`
  / `ErrAsync(e)` / `OkAsync()` are what unthrown ships for this;
  `Ok(v).toAsync()` and `Ok(undefined)` are the boilerplate they replace.
  `.toAsync()` survives only where it lifts a `Result` that already exists —
  `examples/order-application`'s `placeOrder(id, quantity).toAsync()` is the one
  such site.
- **A sequence is `flatTap` or `DoAsync`, never sibling `const`s.** An
  `AsyncResult` is **eager**: constructing it starts the work. So the readable
  spelling of a sequence — each step in its own `const`, then chained — is a
  **race**, and a silent one: it still type-checks and still returns a `Result`,
  it just runs the steps concurrently. Since `@unthrown/oxlint@5.6.0` the gate
  catches it: `unthrown/no-async-result-race` (issue #92, filed from this very
  paragraph's admission) reports sibling constructions where one is consumed
  by a later step's callback — the racing spelling is a lint error now, not a
  convention held by review.
  `flatTap` is the answer where a later step needs only the earlier one's
  _success_: it runs a failable step, discards its value and passes the original
  through, so a five-step saga stays flat instead of becoming five levels of
  indentation. `DoAsync().bind(...)` is the same idea where a later step needs
  an earlier step's _value_, with an accumulating scope.
  `examples/order-temporal-worker`'s `fulfillOrder` and `chargeOrder` are the
  worked examples, and their specs assert the ordering (_"place, reserve, ship,
  in order"_) so a regression to the racing spelling fails a test rather than
  shipping. Measured: the sibling spelling logs `start:a start:b end:b end:a`,
  `flatTap` logs `start:a end:a start:b end:b`.
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
  the package README if its sample is touched — a **runtime** package's
  README also carries an `## Options` index, one line per option with the
  reference page as its one detailed home (issue #26's skeleton: the index
  makes every option greppable on npm, the defaults and reasoning live where
  the deploy gate holds them) — **and**
  `docs-examples.test-d.ts` in the same commit — and when
  the change is to `packages/core/src/` internals or the invariants guarding
  them, `packages/core/CLAUDE.md` too — and for a runtime package, its own:
  `packages/config/CLAUDE.md`, `packages/testing/CLAUDE.md`,
  `packages/http-server/CLAUDE.md`, `packages/temporal-worker/CLAUDE.md` or
  `packages/amqp-worker/CLAUDE.md`, whichever is where that package's public
  surface lives — or `packages/di/CLAUDE.md` for the container, or
  `packages/contract/CLAUDE.md` for the auth marker, or
  `packages/cache/CLAUDE.md`, `packages/mailer/CLAUDE.md` or
  `packages/storage/CLAUDE.md` for the application-service ports. There are
  **thirteen** `CLAUDE.md` files; naming the wrong one is how the last drift
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
  no `typescript.js`). One `typedoc.<name>.json` per package — twelve — points
  at that package's `src/index.ts` (core's one entry point; the doubles are
  `typedoc.testing.json`'s, and `typedoc.observability.json` names two entry
  points, `src/index.ts` and `src/pino.ts`) and writes straight into
  `api/<name>/` (gitignored; `docs/api/index.md` is the one committed file
  there); `scripts/build-api.ts` runs the twelve concurrently.
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
- **Every `ts` fence on the site, in the root README and in the package
  READMEs is compiled by `pnpm typecheck`, continuously.**
  `docs/scripts/extract-doc-samples.ts` extracts them into generated
  `.test-d.ts` modules under four workspaces' `src/generated/doc-samples/`
  (gitignored; regenerated by each workspace's `generate` script, ordered by
  turbo's existing `generate`/`^generate` edges): `packages/core` for
  kernel/di/config/testing pages, `examples/order-api` for HTTP and
  observability, and the two worker examples for Temporal and AMQP. A page's
  workspace is classified from its imports, or pinned with
  `<!-- doctest: group=<name> -->`. Because a fence is a narrative excerpt, a
  page carries hidden TypeScript context in HTML comments the site never
  renders — the Rust hidden-`#`-lines analog: `<!-- doctest: prelude … -->`
  (page-level context; a prelude may import the REAL artifact a page
  describes, since the generated module lives inside the workspace's `src/`),
  `<!-- doctest: skip — <reason> -->` (reason mandatory, printed at generate
  time), `<!-- doctest: defer -->` (same module, emitted after the unmarked
  fences, for a composition root shown before its parts), and
  `<!-- doctest: isolate … -->` (own module; a body after `isolate` is that
  fence's private prelude and makes it fully self-contained). A marker not
  directly above a ` ```ts ` fence fails the generate task. `@ts-expect-error`
  fences are the negative samples, exactly as in the `needs-gate` files. The
  one sample that cannot compile anywhere is `pinoSink`'s — no example
  workspace installs `pino` — held by `packages/observability/src/pino.spec.ts`
  and skipped with that reason. The kernel-only README samples are
  additionally held by `packages/core/src/docs-examples.test-d.ts`, and
  `examples/order-api/src/docs-examples.test-d.ts` still pins the
  application-reality coupling the extraction cannot (its samples call the
  real use cases through the real `auth.ts` by hand).
- **The same script resolves every RELATIVE link in those files, and a link
  that resolves to nothing fails the generate task.** It reports the count it
  checked, so a silent no-op is visible. Root-relative links
  (`/reference/core/start`) are deliberately left alone — VitePress fails its
  own build on those, and a second opinion here could disagree with the one
  that ships — and links inside fences are stripped first, since `](../x)` in
  a sample is code rather than a link.

  It exists because the transport rename broke `packages/core/README.md`'s
  `](../http)` and **nothing noticed**: the site's own routes are checked by
  VitePress, but a package README is not part of the site, and this script
  read every README already without ever looking at a link. A rename has four
  shapes to sweep — the specifier, the workspace path, and the two
  documentation routes — and a relative sibling link is none of them, so the
  one form no gate covered was also the one a regex was most likely to miss.
  Regression-proved: restoring `](../http)` fails `generate` with
  `packages/core/README.md:27 → ../http`.

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

And a seventh, about the infrastructure a suite runs against:

7. **A test file is isolated by the boundary its infrastructure already has,
   never by a server of its own.** A RabbitMQ suite gets a **vhost**, a
   Temporal suite a **namespace**, a database suite a **tenant** — each minted
   in setup, each free, each finer than the thing it replaces. What a suite
   must NOT do is start a copy of the server: that is what made `pnpm test`
   intermittently red at turbo's default concurrency (issue #52), and it buys
   an isolation the logical boundary already gave for nothing. The shared
   containers live in `internal/test-infra`; the per-test boundary lives in
   the workspace's own fixtures.

   The consequence worth stating is that **nothing cleans up after a test**.
   There is no truncate, no drop, no purge — a test that needed one would be
   a test sharing a namespace it should have minted. The fixtures create; the
   run's end is what disposes. A tenant is a UUID and a vhost is a UUID
   precisely so this holds across spec files and across the workspaces turbo
   runs at the same instant.

   The tenant needs no machinery to reach a spec, because the application's
   ports name it: `repository.find(tenant, id)` says what a call is scoped
   to at the call. That is a consequence of the design choice below, not a
   coincidence — an ambient tenant would have needed a fixture to establish
   one, and the kernel exports no way to open a unit.

## Deferred, deliberately

- ~~Caching the Temporal test-server binary in CI.~~ **Closed by deletion**:
  there is no binary any more. The Temporal suites run against the shared
  `temporalio/auto-setup` container, so what CI pays for is a Docker image
  pull its own layer cache handles, not a 64 MB download into a directory a
  reusable workflow could not be told to cache.
- **Reaping the shared containers.** `withReuse()` deliberately keeps them out
  of Ryuk's hands, so they outlive the run — which is the whole point locally
  and pure waste on an ephemeral CI runner that discards the machine anyway.
  There is no harm today; if it ever matters, the fix is a `CI`-conditional
  `withReuse()` in `internal/test-infra/src/containers.ts`, not a teardown
  that would pull a container out from under a concurrent workspace.
- The `@btravstack/oxlint` rule banning `currentUnit()` outside infrastructure
  adapters (Thesis #2) — it needs a way to identify an adapter.
- ~~Traces and metrics in `@btravstack/observability`.~~ **Closed by
  shipping the shape as written** (issue #64): `Tracer`/`Meter` ports and the
  OTel `NodeSDK` as a resourceful provider whose `release` flushes, behind
  the `@btravstack/observability/otel` subpath on the `pino` optional-peer
  protocol; `UnitSpanModule` as a span per unit through `StartOptions.unit`;
  W3C `traceparent` honoured inbound by `@btravstack/http-server` and
  `@btravstack/amqp-worker` (trace-id field only — the parent span id is dropped,
  never half-carried), with `@btravstack/temporal-worker` deliberately keeping the
  workflow id as its correlation. The auto-instrumentation constraint held:
  the preload cannot be DI-provided, so the package ships the graph-owned
  half and the `--import` line stays the deployment's. Surfaces in
  `packages/observability/CLAUDE.md`.
- ~~A `docs-examples.test-d.ts` for `@btravstack/temporal-worker`, `@btravstack/amqp-worker`
  and `@btravstack/observability`.~~ **Closed by the doc-samples gate**
  (issue #94): `docs/scripts/extract-doc-samples.ts` now compiles every `ts`
  fence on the site and in every README under `pnpm typecheck` — see
  **Documentation site**. The trigger had fired again (the amqp and temporal
  READMEs still showed the two-argument `execute` from before the branded
  tenant, a wrong consumer key, and a `DuplicateOrder`-only triage missing
  the `InvalidOrderId`/`InvalidQuantity` arms), and the sweep that built the
  gate fixed a dozen more: pages predating declared `needs`, the slices
  split, `defineHttp`, and di's keyed deps. Regression-proved: reverting the
  temporal README's `execute` to the two-argument form fails `typecheck` with
  `TS2554` naming the README.

  **The HTTP half is no longer deferred**, because that trigger fired twice in
  two days (issues #74 and #75, six pages describing `examples/order-api` as it
  was before it had authentication). `examples/order-api/src/docs-examples.test-d.ts`
  is the gate, and it lives in the **example** rather than in
  `packages/http-server`: the samples call the real `PlaceOrder` / `FindOrder` /
  `FindCustomer` against the real `contract` through the application's own
  `src/auth.ts`, and a stub would have accepted every broken call — passing an
  order id where a tenant goes was exactly the drift. It covers both
  controllers, the keyed router, the `HttpModule` root whose authenticators
  ride the router,
  the lifted single-slice root and the bare `api.HttpRouter(contract)(deps, arm)`
  form the three router-shaped pages share — `docs/index.md`,
  `docs/reference/http-server.md` and `docs/how-to/serve-orpc-over-http.md`, none of
  which puts a controller in between. Every deps record it compiles is
  **keyed**, di's one shape since `feat(di)!: a provider declares its
dependencies by name`; a positional array is refused as
  `not assignable to parameter of type 'Readonly<Record<string, AnyPort>>'`,
  which is what several pages outside this gate carried until the
  doc-samples gate swept them.
  It does **not** cover the pages' own contract
  declarations: `zod` and `@btravstack/contract` are
  `examples/order-api-contract`'s dependencies, not `examples/order-api`'s, so
  a fragment is compiled where it lives — though a marker removed from it
  still fails this file, since the controllers are typed by it. No config
  change was needed; the workspace already wires `test:types`.

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
