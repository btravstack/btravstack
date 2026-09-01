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
holds one more, `test-infra`, which is neither: it owns the six containers
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

   **One runtime does not mean one protocol.** A graph holds exactly one
   runtime, and that is what bounds the process — not what bounds HTTP itself.
   `@btravstack/http-server`'s `HttpHandler` is a **set port** of
   `{ prefix, handle }`, and two answerers ship: oRPC (`orpc()`, from `http()`)
   and htmx fragments (`htmx()`, serving `Html` — an object escaped by
   default). GraphQL is what the package is being extended for next (#179).
   Every member is an answerer under one runtime, routed by longest matching
   prefix, because three runtimes is the one thing this thesis forbids. The
   package's own spec used to say "there is one way to answer HTTP here,
   oRPC"; that was true of the package and was never a consequence of this
   thesis, and it is gone.

   **"HTML" here means fragments, and only fragments** (#179's open question).
   Four things were being called HTML support: a template engine's rendered
   pages, an endpoint answering `text/html` for a partial, static assets with
   an SPA fallback, and JSX/SSR with a component model. `htmx()` is the second
   — the one closest to a procedure and hardest to tell apart from one, which
   is why it sharpened the second-answerer question rather than dodging it. The
   first and fourth are #166's rendering layer; the third is #161, and its own
   counter-argument (that it may still be the ingress's job) stands.

   **The auth cluster was sequenced behind this, and the sequencing paid off in
   a way worth recording**: the seam generalised the moment a second answerer
   landed, rather than needing to be redesigned. `resolvePrincipal` is one walk
   both answerers share, so a scope check cannot drift between protocols — and
   a protocol with **no contract** declares its requirements as **data on the
   route** (`api.HtmxGet(path, { requires: [{ user: [] }] })`), gated by
   `RequiresGate`, the contract-less analogue of oRPC's `ScopeGate`. So
   `AuthenticatorService` is protocol-neutral by construction: it is
   `(headers) => AsyncResult<Granted<P, Scope>, Unauthenticated>` and names no
   protocol at all. A GraphQL answerer inherits that seam by declaring
   requirements the same way; it is not a redesign waiting to happen, which is
   what #179 could not know before the second answerer existed.

   Three consequences for the cluster, and they are not the same:

   - **#157 (authenticators) is not blocked.** Its verification half — JWKS
     fetch and cache, `iss`/`aud`/`exp`, key rotation, constant-time API-key
     compare — never was, and its binding half stopped being blocked when
     `requires`-as-data shipped.
   - **#160 (cookies and sessions) unblocked when `htmx()` landed**, and so did
     the CSRF deferral #164 made on the stated grounds that "this package
     configures no cookies". A session cookie now has a legitimate consumer —
     a browser navigating fragments — which is exactly what it lacked. The two
     move together, and CSRF cannot be reconsidered before cookies exist.
   - **#158 (authorization) was never blocked by any of this.** It is
     `(principal, resource) → decision` in the application layer, above the
     transport; only its `principal` input is protocol-shaped, and nothing it
     decides turns on the number of protocols.

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

   **Scheduling stands by Temporal, and the FLOOR is stated rather than
   discovered** (issue #163). The argument that a workflow already is a durable
   job wins on capability and loses on floor: the smallest thing a team can do
   to run a nightly report here is stand up a cluster, where every competing
   framework answers it in one line with no new infrastructure. That cost is
   now written where an evaluator meets it —
   `docs/how-to/run-something-on-a-schedule.md`, titled what a person searches
   for — with the four things an in-process `setInterval` gets wrong (N
   replicas fire N times, a missed window is silently missed, a retry has
   nowhere to live, and it fights beat 2 of the drain) and the honest
   conclusion: one scheduled job and nothing else is a Kubernetes `CronJob`
   against your own API, not this stack.

   What ships is the one piece the floor does not cover:
   `@btravstack/temporal-worker/schedule`'s `ensureSchedule`, on the
   optional-peer-behind-a-subpath protocol. `@temporal-contract/client` already
   has a fully typed schedule client; what it lacks is **idempotence**, and a
   deploy runs again on every release. `create` answers
   `ScheduleAlreadyExistsError`, the repair everyone reaches for is a
   `try`/ignore, and that hides the failure that matters — a schedule left on
   the server with a spec the deploy stopped writing, a cron that silently
   stopped matching the code. `ensureSchedule` recovers that ONE error into an
   `update` and leaves every other on the channel, still typed; the matcher has
   no wildcard, so a fourth upstream error fails that file rather than being
   recovered into a schedule nobody registered. It writes `spec` and NOT
   `state`: a schedule an operator paused stays paused, because unpausing is a
   decision a person made.

   It is a **subpath rather than a client package**, the one place the naming
   thesis's "a client will be a PACKAGE, never a subpath" does not apply — and
   for that rule's own reason. The rule exists because peers are per-package,
   so a caller must not be made to install the serving half. `ensureSchedule`
   is not the calling half of a contract (it starts no workflow and awaits no
   result); it is a **deployment operation** performed by whoever ships the
   worker, who already holds this package.

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

## Health checks: a module declares one, the kernel collects them

A starter that owns a dependency declares a health check; the kernel folds every
one into `GET /healthz`. `@btravstack/cache`, `@btravstack/storage` and
`@btravstack/prisma` each contribute one, named for the component; a starter an
application never composed contributes nothing, and a set port with no
contributors is empty rather than missing.

**It is a set port, not a registry the kernel hands out.** A registry would
have each starter `needs` it and call `register(...)` while constructing —
which type-checks whether or not the call is ever made, so a starter that
forgot would compile and report healthy forever. A contribution is a provider
like any other: declared, levelled, and visible in the graph.

**This reversed `38d85f7`, which deleted `Port.many`/`Provider.member` because
"an audit found no consumer in any of the eight packages or ten examples".**
That was true when written. It stopped being true the moment a second feature
wanted the same shape — auto-registered OTel instrumentation was the first ask,
health checks the second — and the removal is what made both look impossible.
Restoring it brought back the levelling cost the removal cited, which is real:
`plan` keys `placed` by provider identity and compares member counts, because
keyed by bare `portId` the first member to land drops its siblings.

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
`UniqueConstraintViolation` does, and the application declares its own
`Page<T>` / `PageRequest` / `MalformedCursor` (`order-application`'s
`pagination.ts`) — declared once for the layer rather than per repository, with
no framework type in any port. Nothing here needs to ship for that to be true,
which is why nothing does.

**A flag and its cursor are ONE fact, at both ends of the wire.** `Page<T>`
pairs `hasNextPage: true` with the `nextCursor` that continues the listing and
gives `hasNextPage: false` no such field at all — the same move as
`PageRequest`'s exclusive `after`/`before`, and the contract's `list` output is
the union of the four pages that exist, so a reader that checked the flag holds
a `string` rather than a `string | null` it has to re-check. `page(items, {
previous, next })` is the one constructor and DERIVES the flags from the
cursors, which is what keeps the pair impossible to disagree: a side with no
cursor is a side the caller cannot reach, so `@unthrown/prisma`'s
`hasPreviousPage: true` with a null `startCursor` (an empty page past the end)
is reported as the reachable answer rather than as a flag with nothing to
follow. The two ends spell it
differently on purpose: `Page<T>` is an **intersection of two independent
unions**, one per side, which narrows exactly as four arms would and states
each side once; the contract's schema is the **union of four `strictObject`
arms**, because JSON Schema has no working intersection of closed objects
(`allOf` of two `additionalProperties: false` subschemas validates nothing)
and the OpenAPI document is an interop surface. `strictObject` rather than
`object` there because a stripping parser would answer what its own published
schema rejects.

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
hands back the one finisher that settles them all.

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

CORS, body limits, compression, security headers and authentication are
**handler configuration, not a middleware slot** — thesis #3's refusal, narrowed
to what it was always about, and named options on `http()` / `HttpModule` for
all five. CSRF is the stated exception: oRPC's protection only bites on a
request carrying a `SameSite` cookie, and this package configures no cookies,
so it stays a `plugins` line until they arrive. Rate limiting is a stated
non-goal. The full reasoning is in `packages/http-server/CLAUDE.md`.

## Public surface

Each package's surface is stated **once**, in that package's own `CLAUDE.md`,
and again for a reader on the documentation site. It is deliberately **not**
restated here: this file used to carry a copy, and the copy drifted — it
described `Logger.error`/`fatal` as taking `(message, cause?, attributes?)`
while `logger.ts` shipped `(message, attributes?, cause?)` on all six methods
_and argued for that ordering in its own TSDoc_. Five copies, one gate, and
the copy with no gate is the one that lies.

| Package                       | Surface lives in                                                             | Reference page               |
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

  Coverage exclusions become one entry per workspace, `"src/__tests__/**"`,
  in place of naming each artifact — which is worth having, because
  `@btravstack/cache` shipped with that list one entry short and counted a
  type test as uncovered source.

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
  serves the whole gate.** The tenancy is the APPLICATION's — every port names
  its tenant and no starter reads one off anything. The full rule, the id
  branding and the Prisma generation step are in `examples/CLAUDE.md`.
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

  **All three starters share one shape**: mint a piece straight from a
  contract key — HTTP's `api.OrpcController(contract, path)`,
  `@btravstack/amqp-worker`'s `AmqpHandler(contract, key)`,
  `@btravstack/temporal-worker`'s `TemporalWorkflowActivities(contract, key)` —
  each with the key carried on the piece's own port id rather than on a record
  position, and compose an **array** of them:
  `api.OrpcRouter(contract)([...])`, `AmqpHandlers(contract)([...])`,
  `TemporalActivities(contract)([...])`. Every leaf the contract declares must
  be covered (an uncovered one is refused at the call, against an
  `"UNCOVERED CONTROLLERS — …"` / `"UNCOVERED HANDLERS — …"` /
  `"UNCOVERED ACTIVITIES — …"` marker — at the **tail of the third line** of a
  `TS2769`, past three hundred characters of the caller's own contract, which
  is not shortenable from inside any of the three packages because the width
  is in the type arguments rather than in a name; the missing key is named too
  once the array's length matches the marker tuple's own length of 2, as a
  **separate** diagnostic on the trailing element whose target is the bare
  key), and two slices both discharged for one key are di's duplicate-provider
  defect at build — the exactness comes from the port id every piece carries,
  not from a record shape. HTTP's key space is the one that nests — `"v1"` and
  `"v1.orders"` are different paths into the same contract — so it alone
  carries a **second** gate: `"OVERLAPPING CONTROLLERS — …"`, refusing an
  array where one piece's path sits inside another's, which the flat worker
  key spaces have no way to construct in the first place. See
  `packages/http-server/CLAUDE.md`, `packages/amqp-worker/CLAUDE.md` and
  `packages/temporal-worker/CLAUDE.md` for the full surface, and
  `docs/how-to/split-a-worker-into-slices.md` for the worker-side task — the
  sibling of `controller.test-d.ts`'s do-not-break property above does not
  exist on the worker side: a worker's array has no lifted-fragment form to
  preserve, since a piece already IS one contract key on its own.

- **`examples/order-api` consumes `@btravstack/http-server`**, `order-temporal-worker`
  consumes `@btravstack/temporal-worker` and `order-amqp-worker` consumes
  `@btravstack/amqp-worker` — each supplying its own contract, pieces and triage.
  What each composition root looks like is in `examples/CLAUDE.md`.
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
  each of the three application-service ports carries exactly one more:
  `redis` behind `@btravstack/cache/redis`, `nodemailer` behind
  `@btravstack/mailer/smtp`, and the two `@aws-sdk` packages behind
  `@btravstack/storage/s3` — every one of them `optional: true` in
  `peerDependenciesMeta`, so a graph composing the plain `cache()` over the
  memory adapter installs none of them.
  **Instrumentation is not one of these, and needs no subpath**: `instrument.ts`
  imports `Logger` and `Meter` from `@btravstack/core`, which is where those
  ports are declared, so the `instrumented` flag costs a consumer no dependency
  at all. That is the reason the trio lives in `core` rather than in
  `@btravstack/observability`.
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
- `declarationMap: false` on all thirteen published packages — the published
  tarball has no `src/`, so maps would be dead ends.
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

  It was `>=20` until Node 20 reached end of life on 2026-04-30. That floor
  was never provable — CI runs the dev toolchain, and pnpm 11 needs
  `node:sqlite`, which Node 20 does not have — so it promised a line nothing
  here had ever executed. Raising it is what let `packages/core` drop its
  `createDeferred` shim for `Promise.withResolvers` (ES2024, Node 22), and
  CI's `22.22` row now runs the same major the promise names.

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
  `examples/order-application`'s `placeOrder(id, quantity).toAsync()`,
  `start.ts`'s `probesOptions.toAsync()`, `fromNullable(row, …).toAsync()` and
  the handful like them. It used to say that was **the one** such site, which
  was wrong in both directions: eight sites lift an existing `Result`
  legitimately, and thirty-three lifted a fresh literal in violation of this
  very bullet — across `di`, `observability` and `di-hexagonal`, specs
  included. `.toAsync()` on an `Ok(`/`Err(` receiver is what the rule bans, and
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
  files. Rationale belongs **here**, not inline. The bullet used to end "which
  is what the surviving comments are" and that had stopped being true: measured
  before the sweep, 2 649 inline `//` lines and 4 302 TSDoc lines against 27 762
  lines of TypeScript — **a quarter of the code was comment**, one line in ten
  an inline essay. A reader looking for the code had to skim past the reasons
  for it.

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
   `DRAIN_TIMEOUT_MS`, `HTTP_BODY_LIMIT`, `HTTP_CORS_ORIGIN`, `HTTP_COMPRESSION`,
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
   kernel's own three, since a process has exactly one kernel and nothing else
   binds them.

   Three
   things stay options on purpose — a **shape** (`plugins`, a CORS record's
   allowed headers), because an environment carries strings; a **graph
   decision** (`instrumented`, an adapter choice), because it changes what is
   built rather than how it behaves; and a value whose silent change is a
   security regression, which is why `securityHeaders` is an option and
   `HTTP_CORS_ORIGIN` is a variable. The full index is
   `docs/how-to/configure-from-the-environment.md`.

   `examples/order-config` and the three `env.ts`
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
  workflow id as its correlation. A starter's OWN instrumentation is
  graph-owned: it contributes to `Instrumentations` (declared in `core`) and
  `otel()` registers every contribution, so composing `@btravstack/prisma`
  declares engine tracing and composing `otel()` turns it on — nothing
  registers when no SDK is composed. The auto-instrumentation constraint held
  for the PRELOAD alone:
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
  controllers, the composed router, the `HttpModule` root whose authenticators
  ride the router,
  the lifted single-slice root and the bare `api.OrpcRouter(contract)({ inject, ...arm })`
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
