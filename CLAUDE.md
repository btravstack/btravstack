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

`di` proves the wiring before the process exists. `@btravstack/core` owns
**when** an
already-proven graph is constructed and torn down, and nothing more. Nothing
throws to callers: every fallible operation returns an
[`unthrown`](https://github.com/btravstack/unthrown) `Result`.

pnpm workspace + turbo monorepo. `packages/` holds thirteen published packages,
`contract` (the contract tier: markers and normed shapes a client and the
server that implements it both need — the `authenticated` marker and a cursor
page, with the page's schema behind a `/zod` subpath so the root keeps its
zero dependencies and zero required peers), `di` (the container), `config`
(configuration from the environment, as
providers), `core` (the kernel), `testing` (the test harness — `bootFixture`,
`tapped`, the in-memory runtime, the fake clock; peers on `core`),
`observability` (the observability starter — `createLogger` correlated with
the ambient unit, a JSON sink, the kernel's events as lines, and the OTel
adapter behind its own subpath; it IMPLEMENTS the `Logger`, `Tracer` and
`Meter` ports rather than declaring them, which is `core`'s job), `cache`
`mailer` and `storage` (the three application-service ports of issue #62, on
one shape — a port, a real adapter, an in-process adapter, and one
composition function), and the three
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
container's own `di-hexagonal`, which composes a `Module` and never
calls `start`. They are
consumers, not fixtures: they are part of the gate, and `examples/README.md`
is their index.

**`di-hexagonal` is two things, and the second is why it cannot be
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
redundant with `order-api`, and takes the emit gate with it. `docs/` is the documentation site (see **Documentation
site** below); it is a workspace but not a published package. `internal/`
holds one more, `test-infra`, which is neither: it owns the containers
the whole gate shares and is documented in its own README.

## Commands

The gate — every change must keep all six green, and CI runs the same set:

```sh
pnpm format --check   # oxfmt (run without --check to auto-fix)
pnpm lint             # oxlint (all eight @unthrown rules) + markdownlint-cli2
pnpm typecheck        # tsc, incl. the type-level *.test-d.ts files
pnpm knip             # dead code / unused deps
pnpm test             # vitest + v8 coverage (100% lines/functions, enforced)
pnpm build            # tsdown dual CJS/ESM + d.ts
```

**`lint` runs two linters, and markdown rides it deliberately.** CI's jobs come
from a reusable workflow in `btravstack/tools` with a fixed set — Format, Lint,
Type Check, Knip, Security Audit, Bundle Size, Build, Tests — and no input for
a markdown job. Folding `markdownlint-cli2` into the `lint` script is what puts
it on the gate without changing another repository's workflow. Its config lives
in `.markdownlint-cli2.jsonc`, and every rule it turns OFF carries the
measurement that turned it off — `MD051` in particular, because VitePress and
GitHub slugify a heading differently and enabling it would report eight working
anchors as broken.

Not part of the gate, but the command a contributor runs all day:

```sh
pnpm dev              # the three example deployments, one process each, watching
```

Commits follow Conventional Commits (commitlint via a lefthook `commit-msg`
hook). User-facing changes need a changeset.

## Versioning: all thirteen packages move as one

The thirteen published packages share **one version number**, enforced by a
`fixed` group in `.changeset/config.json`. **Do not downgrade `@changesets/cli`
below 3.0.0** — on 2.x the next `pnpm run version` silently ships a major. The
measurements behind both rules are in `.changeset/CLAUDE.md`.

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

   **The local loop is the production shape, not an exception to it**:
   `pnpm dev` is one process per deployment, never one process booting all
   three. The declined alternative is in the `deferred-decisions` skill, the
   mechanics in `examples/CLAUDE.md`.

   **One runtime does not mean one protocol.** A graph holds exactly one
   runtime, and that is what bounds the process — not what bounds HTTP itself.
   `@btravstack/http-server`'s `HttpHandler` is a **set port** of
   `{ prefix, handle }`, and three answerers ship: oRPC (`orpc()`, from
   `http()`), htmx fragments (`htmx()`, serving `Html` — an object escaped by
   default) and the login (`oidc()`, from `@btravstack/http-server/oidc`,
   which walks a browser through the authorization-code flow and seals the
   session cookie). GraphQL is what the package is being extended for next
   (#179).
   Every member is an answerer under one runtime, routed by longest matching
   prefix, because three runtimes is the one thing this thesis forbids.

   **"HTML" here means fragments, and only fragments** — what that excludes,
   and which issues hold the rest, is in the `deferred-decisions` skill.

   **The auth seam is protocol-neutral.** `resolvePrincipal` is one walk every
   answerer shares, and a protocol with no contract declares its requirements
   as data on the route, gated by `RequiresGate` — so a GraphQL answerer
   inherits the seam rather than redesigning it. The surfaces are
   `packages/http-server/CLAUDE.md` and `AUTH.md`; the worked browser consumer
   is `examples/order-api` (`docs/how-to/log-a-browser-in.md`).

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

   Scheduling stands by Temporal Schedules. The floor that costs — a cluster
   for one nightly job — is stated in `docs/how-to/run-something-on-a-schedule.md`,
   and `ensureSchedule` (a subpath rather than a client package, because it is
   a deployment operation) is in `packages/temporal-worker/CLAUDE.md`.

   **Each transport package is named for the HALF it implements** —
   `http-server`, `temporal-worker`, `amqp-worker` — and a client will be a
   separate `-client` PACKAGE, never a subpath: peers are per-package, so a
   subpath would drag the serving half into a consumer that only calls. Why
   these spellings is in the `deferred-decisions` skill.

2. **Ambient carries DATA. The DI `Context` carries CAPABILITIES.** The kernel
   opens one `AsyncLocalStorage` store per unit holding a small, fixed record —
   `{ unitId, traceId, tenantId, signal }` (`UnitRecord` in `units.ts`) —
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
   tenant id read by the Postgres adapter is not. That is what makes
   `tenantId` **permissible** on the record, and it is not what the examples
   do: `examples/order-application` declares a `Tenant` **port**, each
   deployment's unit module provides it from what the unit was opened for, and
   `UnitRecord.tenantId` stays unset by every shipped starter. A tenant is a
   capability — declared, injected, substitutable, and a missing one is a
   compile error — so it belongs on the `Context` side of this very line; the
   field is there for a hand-rolled runtime whose author has answered what
   establishes a tenant and what happens when it is missing. Legitimate readers are
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

   **Authorization is three layers, and the record carries none of them**
   (issue #158). Scope is in the contract and gated at compile time against
   the scheme's vocabulary; the tenant is a typed dependency of the unit
   scope, so a use case that never said which tenant it serves does not
   compile and a tenant-bound port on a public leaf is not a property; a
   resource rule is a plain function in the handler answering
   `Result<Authorized<T>, Forbidden>`, where `Authorized<T>` is a witness only
   the rule mints and the operation it protects takes nothing else —
   `examples/order-api`'s `orders.export` is the worked case, and what the
   witness buys is that a **forgotten** rule is a compile error (a cast
   remains writable, and is a lie a reviewer can grep for). A service key is
   cut for a tenant the way a login belongs to one, so a `service` unit is
   tenant-scoped by its key exactly as a `user` unit is by its claim.
   Underneath, `@btravstack/prisma/rls` pins every statement to the unit's
   tenant and the policy refuses the rest. The kernel ships no `Policy` port,
   no registry and no `Forbidden`: it cannot invoke a rule that runs after a
   fetch, a registry does not make a missing rule visible where a witness
   does, and a shared error would put one triage arm in three transports —
   the trigger that would reopen it, and has not fired.
   `docs/how-to/authorize-a-request.md` is the position.

3. **The kernel never maps an outcome to a transport.** `Result` → HTTP status
   belongs to the router an application hands `@btravstack/http-server`
   (oRPC's `.result()` triage) — the package itself declines that mapping,
   deliberately — `Result` → activity failure to `@btravstack/temporal-worker`, likewise. `@btravstack/amqp-worker`
   declines it too: `Result` → ack/nack/DLQ is a three-way split between
   `amqp-contract`'s dispatch and the handler, and a `Defect` skips the retry
   budget (`packages/amqp-worker/CLAUDE.md`). The claim that survives across all three transports
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
   `terminationGracePeriodSeconds` default of 30s, and the headroom it leaves
   is beat 3's sibling deadline, `stopTimeoutMs` (default `5_000`) — so the
   three sum to the grace period exactly; raise one and you must raise them
   all. Only a **signal** drains — `stop()` and an uncaught exception both go
   straight to `stopping`, leaving `ExitReport.drain` `undefined`.

   **Every phase now has a deadline, because the ones that did not were where
   a shutdown wedged.** The three beats bounded in-flight WORK and nothing
   bounded the teardown or the boot: a `release` that never settled left the
   phase at `stopping` with no `exited` event, no exit code and no exit
   report — the artefact the lifecycle exists to produce — and an uncaught
   exception mid-build was absorbed entirely, since `shutdown.promise` is read
   inside `runtime.start`'s own `flatMap` and installing the handler had
   already suppressed Node's exit `1`. So `stopTimeoutMs` bounds
   `stopping` (`Serving.stop` **and** di's finalisers, which is why the race
   sits at `Module.scoped` rather than inside `finish`), a crash or a **second**
   signal before `serving` abandons the build, and either reports
   `ExitReport.abandonedAt` with a `stoppedWaiting` event and exit `2`. It is
   "stopped waiting", never "cancelled": nothing can cancel a finaliser, so a
   wedged one can still hold the loop until SIGKILL — what changes is that the
   report exists and names the phase. A FIRST signal mid-build stays buffered
   and drains once serving, which is what beat 2's charge-from-request
   arithmetic depends on.

   **A long-lived stream is a unit, and the HTTP runtime resets it at beat
   3's start** (issue #137): `@btravstack/http-server` destroys a
   `text/event-stream` response when `Serving.drain` is called, so the client
   reconnects to a replica that is staying. That is transport semantics inside
   the runtime's `drain` — the kernel stays three beats. Why a reset rather
   than a clean end is in `packages/http-server/CLAUDE.md`.

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

8. **Computation-shaped is out of scope.** This framework's territory is
   deployment opinions and starters — the drain, exit codes, probes,
   configuration from the environment, set-port contributions, the transport
   role map. Generic async control flow is not: no fiber system, no retry
   algebra, no streaming, no scheduler. A feature request shaped like "generic
   computation" is answered by Temporal, the platform, or "no" — Effect
   already exists, and a kernel that grows computation primitives one
   hand-built piece at a time is re-implementing it with fewer people. The
   hedge is structural: application code stays plain TypeScript returning
   `Result` and di stays at composition roots, so an Effect-based runtime
   could one day be one more starter without touching business code. The
   kernel being small is the strategy, not a temporary condition.

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

Three obligations, each silent when broken. Their full statement, with the
measurements behind them, is the `RunUnit` / `RuntimeHost` / `UnitMeta` TSDoc,
`docs/how-to/write-a-runtime.md` and `docs/reference/core/runtime.md` — keep
those three in sync.

1. **The response must be flushed INSIDE the unit.** A unit closes the instant
   its `Result` settles, and an idle registry is the kernel's permission to
   tear the transport down — a runtime that resolves first and writes after
   loses large bodies.
2. **`UnitMeta.id` must be unique per unit, unless a `traceId` is supplied.**
   `traceId` defaults to `meta.id`, so a category id (a route template) gives
   every request the same trace id.
3. **A fork's scope is not synchronous with `host.run`.** Call
   `unit.fork(module, seed)` inside the work callback; a port the module
   provides exists only in the forked `Context`, never in `host.ctx`, and a
   runtime that subscribes to an event from inside its work (a response's
   `'close'`) must first check whether it already fired.

## Health checks: a module declares one, the kernel collects them

A starter that owns a dependency declares a health check; the kernel folds every
one into `GET /healthz`. `@btravstack/cache`, `@btravstack/storage`,
`@btravstack/prisma` and `@btravstack/mailer` each contribute one, named for
the component — the mailer's on its SMTP **adapter** rather than on the
composition, since the recording adapter sends nowhere and would report healthy
for free; a starter an
application never composed contributes nothing, and a set port with no
contributors is empty rather than missing.

**It is a set port, not a registry the kernel hands out.** A registry would
have each starter `needs` it and call `register(...)` while constructing —
which type-checks whether or not the call is ever made, so a starter that
forgot would compile and report healthy forever. A contribution is a provider
like any other: declared, levelled, and visible in the graph.

**`/healthz` does not gate `/readyz`, and that is the decision.** Readiness
removes a pod from its Service's endpoints; failing it on a dependency the
replicas share removes all of them at once, turning a degraded system into an
outage. The kernel reports; an operator decides.

## Persistence: one starter, and pagination is the adapter's

`@btravstack/prisma` is the only persistence starter, and there is **no second
adapter and no repository base type** — a decision, not a backlog item (#156).

**A repository base class would smuggle a persistence shape into the
application's ports**, which is the coupling the hexagonal examples exist to
prevent. A port does not say where its data lives (thesis #2's transaction
argument), so a `find`/`save`/`remove` supertype the framework owns would be
asking every store to answer one query language. The methods each example writes
by hand are the only place its own vocabulary appears, and that is what makes
them worth writing: `prismaOrderRepository.list` is the tenant filter, the
library's cursor call and the translation of `InvalidCursor` into
`MalformedCursor` — three decisions this application owns, none of which a
supertype could have made for it.

**Pagination is expressible once and already is — one layer lower.**
`@unthrown/prisma`'s `tryPaginate(query).withCursor({ limit, after })` owns the
cursor arithmetic, in the adapter, and answers `[rows, meta]` with
`InvalidCursor` as its one modeled failure. `examples/order-infrastructure`'s
`list` is the worked case: the library's shape stops at the adapter exactly as
`UniqueConstraintViolation` does. The ports speak `@btravstack/contract`'s
`Page<T>` / `PageRequest` — the normed page a client needs as much as the
server, which is why it lives in the contract tier — and the application
declares only its own `MalformedCursor` (`order-application`'s
`pagination.ts`). No persistence type reaches a port.

**A flag and its cursor are ONE fact, at both ends of the wire** — why
`Page<T>` is an intersection of two unions while the contract's schema is a
union of four `strictObject` arms is in `packages/contract/CLAUDE.md`.

**The filter is a field, never a query object.** `OrderQuery` is
`PageRequest & { minQuantity? }`. A port taking a predicate or a `where` record
would be the application speaking the adapter's language, and the next store
would have to implement it.

A second adapter (Drizzle, Kysely) is a real gap against the frameworks this
competes with and is deliberately not closed yet: it is a new package with its
own health check, instrumentation and container on the gate, and the shape
above is what it would have to satisfy — an adapter, not a base class.

## Observability is a set port, never a flag

A starter reports what it did to `Observers` — declared in `@btravstack/core`,
contributed to by `@btravstack/observability` — and holds no `Logger`, `Meter`
or `Tracer` of its own. `observe(observers, operation)` starts every member and
hands back the one finisher that settles them all; `observed(observers,
operation, call, settled?)` is that wrapped around one `AsyncResult`-returning
call, settling `ok` or `error` from the channel the call came back on, so a
starter's instrumentation is one line per method rather than a `tap` /
`tapFailure` pair each.

**This replaced an `instrumented` flag on six packages, and the flag was the
mistake.** It defaulted to `true`, which put `Logger`, `Meter` and `Tracer` in
the module's `Needs` — so a root that wanted a cache, or an HTTP server, and no
OpenTelemetry SDK got a compile error naming three ports and had to find an
option to turn off something it never asked for. The set port has the property
the flag was reaching for and could not have: **on when observability is
composed, free when it is not, and one composition either way.** It is the
health-check argument again — a starter DECLARES, and composing the collector
is what turns the declarations on.

Four things are load-bearing:

- **A reader of the port contributes a no-op member of its own.** A collector
  depending on a set port nothing provides is an unmet dependency, at plan time
  and in `Needs` alike — `otel()` already does this for `Instrumentations`.
  Several no-ops in one graph cost one inert call each, per operation.
- **The observer is called at the START and answers a finisher.** A span
  reconstructed afterwards from a duration is not the parent of anything that
  ran inside it, so "tell me it finished" would have made the tracing half
  impossible.
- **Dimensions and details are separate.** `attributes` are bounded and ride
  the instruments; `details` are unbounded — a cache key, a mail subject, a URL
  — and ride the span and the error line only. Without that split every
  contributor would have to choose between a useful span and a safe metric,
  which is exactly why a shared observer had looked impossible.
- **`otel()`'s member injects nothing and reads the OTel globals per
  operation.** Depending on `Tracer`/`Meter` there is a dependency CYCLE — the
  SDK collects `Instrumentations`, a contribution may read `Observers`, and the
  member would close the loop back onto the SDK. The tracing API answers a
  proxy that resolves on registration; the metrics API does not, so the meter is
  read per operation and only the instruments it mints are cached.

**A success writes no line.** It is what the metric is for, and a line per
successful operation broke an application spec asserting that neither its
controller nor its interactor had written anything — an absence worth being
able to assert. A component with a success worth an operator's attention writes
that line itself, in its own words; `@btravstack/mailer` lost its "mail sent"
on those terms.

The one `Logger` a starter still holds is `@btravstack/prisma`'s, for the
`debug` line saying engine tracing is off because the optional peer is absent.
That is a STARTUP fact rather than an operation, so there is nothing for an
observer to settle.

## Cross-cutting concerns: configuration, not a middleware slot

CORS, body limits, compression, security headers, authentication and CSRF are
**handler configuration, not a middleware slot** — thesis #3's refusal, narrowed
to what it was always about, and named options on `http()` / `HttpModule` for
all six. CSRF was the stated exception while nothing here read a cookie; a
session scheme does, so `csrf` is an option like the rest, **on by default
exactly when a composed scheme reads one** — a set port each cookie-reading
scheme contributes to, so the default is a fact about the graph rather than a
line somebody remembered to write. The check itself is stateless: a
state-changing request carrying cookies must be same-site by fetch metadata,
or carry an `Origin` matching the request's own host, and is refused with
`403` before dispatch. Rate limiting is a stated non-goal. The full reasoning is in `packages/http-server/CLAUDE.md`.

## Public surface

Each package's surface is stated **once**, in `docs/reference/*` — compiled by
the doc-samples gate — and in the source TSDoc behind it. A package's
`CLAUDE.md` keeps only what neither can say: its decisions, its gotchas and
what it deliberately leaves out. The surface is not restated there or here: a
copy with no gate is the copy that lies.

| Package                       | Decisions and gotchas                                                        | Reference page               |
| ----------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| `@btravstack/contract`        | `packages/contract/CLAUDE.md`                                                | `/reference/contract`        |
| `@btravstack/di`              | `packages/di/CLAUDE.md`                                                      | `/reference/di/`             |
| `@btravstack/config`          | `packages/config/CLAUDE.md`                                                  | `/reference/config`          |
| `@btravstack/core`            | `packages/core/CLAUDE.md`                                                    | `/reference/core/`           |
| `@btravstack/testing`         | `packages/testing/CLAUDE.md`                                                 | `/reference/testing`         |
| `@btravstack/observability`   | `packages/observability/CLAUDE.md`                                           | `/reference/observability`   |
| `@btravstack/cache`           | `packages/cache/CLAUDE.md`                                                   | `/reference/cache`           |
| `@btravstack/mailer`          | `packages/mailer/CLAUDE.md`                                                  | `/reference/mailer`          |
| `@btravstack/storage`         | `packages/storage/CLAUDE.md`                                                 | `/reference/storage`         |
| `@btravstack/prisma`          | `packages/prisma/CLAUDE.md`                                                  | `/reference/prisma`          |
| `@btravstack/http-server`     | `packages/http-server/CLAUDE.md` (auth half: `packages/http-server/AUTH.md`) | `/reference/http-server`     |
| `@btravstack/temporal-worker` | `packages/temporal-worker/CLAUDE.md`                                         | `/reference/temporal-worker` |
| `@btravstack/amqp-worker`     | `packages/amqp-worker/CLAUDE.md`                                             | `/reference/amqp-worker`     |

**Four ports are declared in `@btravstack/core` and implemented elsewhere:
`Logger`, `Tracer`, `Meter` and `Observers`.** That is the one place the table's
"decisions and gotchas" column splits from "who ships the behaviour", and it is
deliberate: a contract that other framework packages depend on has to be
reachable without installing an implementation, and `core` is the package all
of them already peer on — so `@btravstack/cache` can count its hits without
its consumers installing a logging package and an OpenTelemetry SDK to
compile. The tracing pair is declared **without naming OpenTelemetry**, as a
narrowing its real types satisfy structurally, so the vendor stops at
`@btravstack/observability/otel`. Their detailed home is
`/reference/core/observability`.

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

- **A spec lives beside what it tests; a test artifact lives in
  `src/__tests__/`.** Co-location is the point — `build.spec.ts` and
  `build.test-d.ts` sit next to `build.ts`, so renaming a source moves its
  tests in the same listing and nothing has to be looked up. What moves out is
  the code with **no subject**: `test-fixtures.ts` (the extended `it`) and
  `di`'s `type-assert.ts`. Those are helpers a spec imports, not tests of
  anything, and they are the files that made a package's directory read as
  half scaffolding.

  **`vitest.d.ts` stays in `src/`, and that is measured rather than
  preference**: moving it into `src/__tests__/` silently drops the
  `ProvidedContext` augmentation it exists to carry, and every `inject("…")`
  in the workspace becomes `never`. The file is in the program either way —
  `tsc --listFiles` shows it — so the mechanism is not simply inclusion; the
  behaviour is what is recorded, not an explanation of it. It is an ambient
  declaration for the workspace's type environment, not a test helper, which
  is the reason it reads as belonging in `src` anyway.

  The coverage block is stated ONCE, as `vitest.shared.ts`'s `covered()`,
  which every published package merges over the shared config — it used to
  be thirteen copies, and `@btravstack/cache` shipped with its copy one
  exclusion short, counting a type test as uncovered source. A package with
  more to exclude names only the extra file (`covered("src/test-workflows.ts")`).

  **Three import forms break when one of these files moves, and only the
  first is caught by the compiler**: a static `from "./x.js"`, a dynamic
  `await import("./x.js")` (a string — `di`'s `scoped.spec.ts` has the one
  that remains, and it is not a helper reach but the surface under test: it
  imports `index.js` as a RECORD to assert what the package exports, which no
  static import expresses), and an
  `import.meta.url` anchor, which no type checker can see at all and which
  only the test run reports. The temporal fixtures carry two of the third
  kind; `fixturePath(callerUrl, name)` appends the **caller's** extension, so
  the hop out of `__tests__/` rides the name (`"../workflows"`) rather than
  the URL.

- **`examples/` is part of the gate, not a folder of illustrations.** All ten
  workspaces run under the same six commands as the kernel, and an example that
  stops compiling fails CI exactly as `packages/core` would. The type-level gates
  they pin, and the `pnpm dev` local loop, are in `examples/CLAUDE.md`.
- **The whole gate runs on shared containers, and `internal/test-infra` owns
  them** — started once per machine and reused by every workspace's vitest run
  and by `pnpm dev`. Its README lists them, why each exists, the reuse lock and
  how to clear them; a workspace that needs Docker says so in its own README.
  Isolation is per boundary, never per server (Test conventions rule 7).

- **The example application is multi-tenant, and that is why one database
  serves the whole gate.** The tenancy is the APPLICATION's — a `Tenant` port
  it declares, provided by each deployment's unit module from what the unit was
  opened for, with the repository bound to it inside that fork; no starter
  reads a tenant off anything and no orders port names one. The full rule and
  the id branding are in `examples/CLAUDE.md`; what keeps a tenant parameter
  is the header of `examples/order-application/src/tenant.test-d.ts`, and the
  Prisma generation step is in `examples/order-infrastructure/README.md`.
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
  `api.OrpcController(contract, path)({ inject: { name: Dep }, sync })` mints a piece
  from the contract path it serves — `api` being the application's one
  `defineHttp(...)` binding; the root composes every slice's piece into one
  router with `api.OrpcRouter(contract)([...])`, an array whose paths must
  partition the contract's procedures (see `packages/http-server/CLAUDE.md`).
  **A fragment is itself a valid contract**,
  so a slice lifts out of the modulith into a process of its own without its
  controller changing at all: the lifted root is
  `api.OrpcRouter(contract.orders)({ inject: { implementation: ordersController.port }, sync: ({ implementation }) => implementation })`,
  declaring the very provider the modulith composed and handing back what it
  built — a new composition root and one fewer import,
  not a rewrite of the slice. That exact call is `controller.test-d.ts`'s fifth
  gate, deliberately naming the controller: a fresh `sync` over the fragment
  would pin only the weaker "a fragment is a valid contract" half. This is what
  makes composing several slices into one router a starting point rather than a
  trap, and it is the one property marked do-not-break in the design.

  **The LEAF is one shape on all three transports**, oRPC's: one record
  carrying everything the invocation has, `input` included, and that input
  repeated as a second positional parameter. Why oRPC's, and the naming
  asymmetry still undecided, are in the `deferred-decisions` skill.

  **All three starters share one shape**: mint a piece from a contract key
  (`api.OrpcController(contract, path)`, `AmqpHandler(contract, key)`,
  `TemporalWorkflowActivities(contract, key)`) and compose an **array** of them
  (`api.OrpcRouter(contract)([...])`, `AmqpHandlers(contract)([...])`,
  `TemporalActivities(contract)([...])`). An uncovered leaf is refused at the
  call — the `UNCOVERED …` marker sits at the tail of the `TS2769`'s third
  line — a leaf discharged twice is di's duplicate-provider defect, and HTTP's
  nested key space adds `OVERLAPPING CONTROLLERS`. HTTP's gates are in
  `packages/http-server/CLAUDE.md`; the worker side is
  `docs/how-to/split-a-worker-into-slices.md`.

- **`examples/order-api` consumes `@btravstack/http-server`**, `order-temporal-worker`
  consumes `@btravstack/temporal-worker` and `order-amqp-worker` consumes
  `@btravstack/amqp-worker` — each supplying its own contract, pieces and triage.
  Each composition root is its deployment's `src/module.ts`.
- **oRPC is pinned to an exact beta** in the catalog, because oRPC v2's
  `latest` dist-tag is still the **1.x** line while `@unthrown/orpc` peers on
  `^2.0.0-beta`: an unpinned range resolves 1.x and fails
  `strictPeerDependencies`. The exact beta is the contract until v2 goes
  stable; raise it deliberately, not on a bot bump.
- **`temporal-contract` is pinned to an exact beta, for the same shape of
  reason**: its `latest` dist-tag is the **7.x** line, which peers on an older
  `unthrown` major and ships neither the `test-rig` nor the `workflow-bundle`
  subpath the Temporal example's specs are built on.
- **Runtime dependencies: none.** `unthrown` and `@btravstack/di` are **peer**
  dependencies of `@btravstack/core` — the dual-copy hazard is real for both
  (di's port identity and unthrown's `isResult` each compare across copies) —
  and every in-repo package that needs them peers on them for the same reason.
  `node:` builtins only otherwise. Do not add a dependency — `Config` is
  hand-rolled Standard Schema for exactly this reason. An in-repo peer is
  `workspace:*` in `devDependencies` and `workspace:^` in `peerDependencies`,
  which pnpm rewrites to a real `^` range at publish — never a literal range,
  which goes stale silently the first time the dependency is bumped. A
  **starter** peers on its transport's libraries (peers, not dependencies, so
  an application holds one copy of each), and a vendor adapter is an
  **optional peer behind a subpath** — `optional: true` in
  `peerDependenciesMeta` and its own `tsdown` entry point — so a consumer that
  never imports the subpath never installs it. `package.json` is the
  inventory.
- **`packages/core`'s specs use `@btravstack/testing` without depending on
  it** — that would be a package-graph cycle turbo refuses — so four configs
  carry the wiring and move together: see `packages/testing/CLAUDE.md`.
- `declarationMap: false` on all thirteen published packages — the published
  tarball has no `src/`, so maps would be dead ends.
- **A deployment extends `@btravstack/tsconfig/app.json`; everything that
  exports something keeps `base.json`.** The two differ in one thing,
  `declaration: false`, and the split is a DX decision rather than tidiness.
  With `declaration: true`, an exported binding whose inferred type is a
  wiring ERROR state exposes di's unexported brand symbols — and TypeScript
  reports that **before** it reports the mistake, so the first thing a reader
  meets is di's internals rather than their own error. Dropping a controller
  from `api.OrpcRouter(contract)([...])` in `examples/order-api` is the probe;
  under `app.json` the `TS4023` block is gone and the real `TS2345` is line
  one. It is not every wiring mistake — one that surfaces at a call site
  rather than in an exported binding produces no `TS4023` at all — but the
  router case is the common one.

  Only the three deployments move (`order-api`, `order-temporal-worker`,
  `order-amqp-worker`): they emit no declarations in production, and they are
  where the composition roots live. **Every workspace that exports a port or a
  contract stays on `base.json`**, and `di-hexagonal` most of all — examples
  carrying `declaration: false` is precisely what let the `TS4020` class ship
  once already, with the repo green and no consumer able to build.

- **Relative imports carry `.js`.** `moduleResolution: NodeNext` plus
  `verbatimModuleSyntax`, both inherited from `@btravstack/tsconfig/base.json` —
  an external package under `node_modules`, so this is the one convention here
  the repo itself cannot show you. `import { x } from "./units"` fails
  `pnpm typecheck` with TS2835.
- All thirteen published packages claim `engines: { node: ">=22" }` while the root
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
- The repo dogfoods **every** `@unthrown/oxlint` rule, opt-ins included
  (`no-throw`, `no-get-or-throw`). oxlint refuses to parse a config naming an
  unknown rule, so a config still listing a rule an upgrade removed fails the
  **whole** lint run, every non-unthrown rule included.
  So a `throw` is a lint error everywhere, spec files included: every one
  that survives carries an `oxlint-disable-next-line unthrown/no-throw`
  naming why. In the kernel and the harness they fall into three kinds — a
  **loud test fixture** whose failure means the _test_ is buggy
  (`packages/testing`'s `test-runtime.ts` misuse guards and `tapped.ts`'s
  read-before-boot; `packages/core`'s `invariants.spec.ts`'s `boundPort`;
  `packages/observability`'s `test-fixtures.ts`'s `Recorder.only()`), a
  **harness rethrow** that is the only way a defect or a `use` failure reaches
  the test runner (`boot-fixture.ts`'s), and a throw that **is the subject
  under test** (`events.spec.ts`'s throwing sink, `units.spec.ts`'s throwing
  unit, `logger.spec.ts`'s throwing sink, and the defects `run-main.spec.ts`,
  `drain.spec.ts` and `health.spec.ts` mint — `Defect` has no public
  constructor, so a throw inside a combinator is the only way). The kinds are
  what a reader needs; **the tally is not here on purpose** — `rg
"unthrown/no-throw"` answers it against the code, where a number in this file
  answers it against whenever it was last counted (#192). `no-get-or-throw` is switched off for the `**/*.spec.ts` **and
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
  `examples/order-application`'s `placeOrder(id, quantity).toAsync()`,
  `start.ts`'s `probesOptions.toAsync()`, `fromNullable(row, …).toAsync()` and
  the handful like them. `.toAsync()` on an `Ok(`/`Err(` receiver is what the rule bans, and
  the receiver is what makes it mechanical: no lint rule enforces it here yet
  (btravstack/unthrown#260).
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
- **Comment density: sparse, and the rule now has a test.** No comments in JSON
  files. Rationale belongs **here**, not inline.

  A comment earns its line only if it passes one of four tests:

  1. **It guards a specific line against a plausible "simplification"** — the
     `teardownErrors` aliasing, the `ready()` latch, the monotonic `completed`,
     `closedOf`'s `response.closed` check. One or two lines, naming what breaks.
  2. **It is TSDoc stating a symbol's contract** — what it does, and any
     obligation a signature cannot express (the two contracts a runtime owes).
     Public API only; TypeDoc turns it into the reference page.
  3. **It is a directive with a reason** — `oxlint-disable`, and a
     `@ts-expect-error` in a `*.test-d.ts` naming the error it expects.
  4. **It is a `// GIVEN` / `// WHEN` / `// THEN` marker** (Test conventions
     rule 4, which explicitly exempts them from this bullet).

  Everything else goes: history ("it was X until…"), measurements, alternatives
  considered, issue numbers, cross-references to other files, and any comment
  restating the line under it. All of that is what **this file**, the
  documentation site and `git log` are for — and unlike a comment, they are
  read on purpose rather than scrolled past, and this one is gated by review
  instead of drifting silently. Prose that argues for a design belongs in a
  thesis above; prose that explains a package's surface belongs in that
  package's own `CLAUDE.md` and its reference page.

- Test mechanics: `@unthrown/vitest`'s matchers are registered via `setupFiles`
  (`toBeOk`, `toBeOkWith`, `toBeErrTagged`, …). Timing is asserted through
  `createFakeClock`, never a real `setTimeout` — a kernel whose own tests are
  slow gets tested badly. `*.test-d.ts` files are excluded from the build, from
  oxlint and from knip; they are checked by `tsc -p tsconfig.test-d.json`, which
  `pnpm typecheck` runs. Every one of those files is two lines over
  `@btravstack/tsconfig/test-d.json` — the preset carries the reason
  (`noUnusedLocals` and `noUnusedParameters` off, because an assertion binding
  is never read) and each workspace states only its own globs. The preset goes
  **last** in the `extends` array so its relaxations win, and it carries no
  `include`: TypeScript resolves a base config's globs relative to the base
  file's own directory, so a shipped one would point inside `node_modules`.
  The structural rules are in **Test conventions** below.
- **Prose carries reasons, never counts.** A number in a spec file either sits
  behind a gate that recomputes it or is deleted in favour of the reason it was
  counting. Measured across the whole repository (#192): every claim behind the
  doc-samples gate held — all seven numeric defaults included — and essentially
  every hand-kept tally in ungated prose was stale, while the reasoned lists
  beside them (what each spec pins, why each disable exists) were accurate. A
  count is the one kind of sentence that goes wrong on a commit that never
  touched it. So `rg` answers "how many"; this file answers "why", and the
  numbers that remain are the ones something else holds to account — a count
  printed beside the table that enumerates it, an exit code, a default in
  milliseconds.

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
  them, `packages/core/CLAUDE.md` too — and the `CLAUDE.md` of any package
  whose decisions or gotchas the change touches. Naming the wrong one is how
  the last drift happened.

## Documentation site

`docs/` is `@btravstack/docs`, the VitePress site published to
<https://btravstack.github.io/btravstack/>. Its build, the TypeDoc wiring, the
doc-samples gate and the link checker are documented in `docs/CLAUDE.md`.

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
where the shape of a spec is itself read as advice. Most of the kernel's specs
predate them and are
**deliberately not swept**: they are mutation-verified, hold
the package at 100% line and function coverage, and are the tests guarding the
shipped invariants — restructuring them buys consistency while risking exactly
the weakening rules 4 and 5 exist to prevent. A **new or rewritten** kernel spec
follows all five; an untouched one is not churned for it.

That split was measured, not assumed. An audit of the kernel's specs found the
substantive rules already kept and the structural ones not: the one conditional
assertion it turned up was a redundant `isOk()` block re-checking a field the
preceding deep `toBeOkWith` had already pinned exactly, since deleted, and the
kernel's expects-per-test sat well under what the examples carried before their
sweep. Optional chaining survives in exactly one shape and it is not an
assertion declining to run: `units.spec.ts` reads `seen?.unitId` where `seen` is
what `currentUnit()` answered **inside** the unit, so a `?.` that found nothing
would compare `undefined` against `"u-1"` and fail. The rule is about a guard
that can skip the comparison, not about the operator.

1. **`describe` is the first statement a reader meets.** After the imports,
   nothing but `describe`. A file that opens with 144 lines of helpers makes a
   reader scroll past the scaffolding to reach the subject, and every one of
   those helpers is invisible state a test silently depends on. What a test needs
   should arrive **through its own parameter list**, so the dependency is written
   down at the point of use.
2. **Helpers are Vitest fixtures, injected via `test.extend`, and they live in
   one `test-fixtures.ts` beside the specs** — `tests/` in a workspace whose
   tests have moved out of `src`, `src/` in one where they have not yet. The
   module exports an extended `it`, which
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
   out-of-range are all named; a **flag** is `true`/`false`, `1`/`0`,
   `yes`/`no` or `on`/`off` in either case and **errors on anything else
   rather than reading it as falsy**, since `HTTP_COMPRESSION=enabled` meant to
   turn it on. Any Standard Schema is accepted in place of
   `Config.object` (a `zod` object over the raw variables) — the practice
   _"Accept any Standard Schema validator"_ — but the fields exist so the
   framework's own starters, and an application with ordinary needs, bring no
   schema library at all.

   **The test of whether something belongs in the environment is whether it
   varies by deployment, not whether it is "configuration-shaped."** A drain
   timeout has to agree with a pod's `terminationGracePeriodSeconds`, a CORS
   origin with whoever is calling, a body limit with what the endpoint
   accepts — all in the manifest, none in the image. So `PRE_DRAIN_DELAY_MS`,
   `DRAIN_TIMEOUT_MS`, `STOP_TIMEOUT_MS`, `HTTP_BODY_LIMIT`, `HTTP_CORS_ORIGIN`, `HTTP_COMPRESSION`,
   `TEMPORAL_GRACE_PERIOD_MS`, `TEMPORAL_FORCE_AFTER_MS` and
   `AMQP_CONNECT_TIMEOUT_MS` are fields beside `PORT`, `HOST`,
   `TEMPORAL_ADDRESS` and `AMQP_URL`, each **pinned** by the matching option:
   the option is what a test or a settled decision fixes, the variable what a
   deployment sets, and `Config.pinned` decides between them per field.

   **A variable carries its starter's prefix** — `HTTP_`, `TEMPORAL_`, `AMQP_`,
   `STORAGE_S3_` — because several starters share one process (an HTTP
   deployment that publishes to AMQP and reads a database composes three), and
   a bare name like `BODY_LIMIT` is one the next starter would also want. The
   exceptions are names the **ecosystem** already owns and a platform injects
   (`PORT`, `HOST`, `DATABASE_URL`, `REDIS_URL`, `SMTP_URL`, `LOG_LEVEL`),
   where a prefix breaks the convention rather than protecting it — and the
   kernel's own, since a process has exactly one kernel and nothing else
   binds them.

   Three
   things stay options on purpose — a **shape** (`plugins`, a CORS record's
   allowed headers), because an environment carries strings; a **graph
   decision** (an adapter choice), because it changes what is
   built rather than how it behaves; and a value whose silent change is a
   security regression, which is why `securityHeaders` is an option and
   `HTTP_CORS_ORIGIN` is a variable. The full index is
   `docs/how-to/configure-from-the-environment.md`.

And a seventh, about the infrastructure a suite runs against:

7. **A test file is isolated by the boundary its infrastructure already has,
   never by a server of its own.** A RabbitMQ suite gets a **vhost**, a
   Temporal suite a **namespace**, a database suite a **tenant**, an OpenID
   Connect suite an **identity** — each minted
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

   The tenant reaches a spec as **one module** — `tenantOf(tenant)`, composed
   beside the vertical — because the application declares it as a `Tenant`
   port rather than reading it off the ambient record. That is a consequence
   of the design choice, not a coincidence, and it is what keeps the fixture
   free of the kernel: an ambient tenant would have needed a fixture that
   OPENED a unit to establish one, and the kernel exports no way to do that,
   where composing a module needs nothing from it — and composes the same
   thing a deployment's unit module does.

## Deferred, deliberately

The register of what this repository has declined, deferred or already closed —
container reaping, the `currentUnit()` lint rule, traces and metrics in
`@btravstack/observability`, the doc-samples gate — is the
`deferred-decisions` skill (`.claude/skills/deferred-decisions/SKILL.md`). It
loads on invocation rather than in every session, because it is read when a
feature is being PROPOSED, not while code is being written. Read it before
proposing a feature, a package, a lint rule or a gate that sounds new: a
struck-through entry there has already shipped, and an open one names the
trigger that would reopen it.
