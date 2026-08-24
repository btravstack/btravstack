---
title: Glossary
description: Short definitions of the terms used throughout the start documentation, each linking to the page that treats it.
---

# Glossary

> **Reference.** Short definitions of the terms used throughout the
> documentation, alphabetically. Each links to the page that treats it in depth.

**abandoned** — A unit still open when the drain deadline passes. It is aborted through its
`AbortSignal` and counted in `DrainReport.abandoned` — the field the exit code
keys on (`2`). See [ExitReport and DrainReport](/reference/core/exit-report).

**ambient record** — The small, fixed `UnitRecord` — `{ unitId, traceId, tenantId, deadline, signal }` —
the kernel opens in an `AsyncLocalStorage` store for a unit's whole extent, and
`currentUnit()` reads. It carries **data**, never services; `signal` is the
very `AbortSignal` the unit's work callback is handed, so a middleware-shaped
runtime — a Temporal activity, an AMQP delivery — can still honour the drain
deadline. See
[Ambient data, injected capabilities](/explanation/ambient-vs-context).

**composition root** — The one module a process boots: it imports the application and a starter,
and exports the runtime port. `HttpModule("OrderApi")({ router, imports, … })`
is one. See [Modules](/reference/di/modules) and [Starters](/explanation/starters).

**context** — `Context<R>` — what a built graph hands out: `ctx.get(Port)` for any port in
`R`. `RuntimeHost.ctx` is the application context; unit work receives the
forked one. See [Entry points](/reference/di/entry-points).

**contract** — The transport-neutral description of what a process answers, in a package of
its own so a client can take it without the server: an oRPC contract for HTTP,
a `temporal-contract` for a Temporal worker, an `amqp-contract` for AMQP. The
starter's port-and-provider sugar types the application's record from it. See
[Starters](/explanation/starters).

**defect vs error** — An **error** (`Err`) is a modeled outcome, visible in a `Result`'s `E`; a
**defect** is an unmodeled failure — a throw, a bug — invisible to the type
and observable only by `match`/`recoverDefect`. The kernel passes both through
untouched. See [Nothing throws](/explanation/nothing-throws).

**drain** — The signal-driven shutdown, in three beats: readiness flips false, the
pre-drain delay elapses, then the runtime stops accepting and in-flight units
get `drainTimeoutMs`. Only a signal drains; `stop()` and a crash do not. See
[Draining, in three beats](/explanation/draining-in-three-beats).

**exit code** — What `runMain` sets `process.exitCode` to from an `ExitReport`: `0`, `1`,
`2`, `70` or `78`. See [runMain and exit codes](/reference/core/exit-codes).

**export** — A port a module makes visible to whoever imports it. Only exports reach the
context; a provided-but-unexported port is private to the module. See
[Modules](/reference/di/modules) and [Keep a port private](/how-to/keep-a-port-private).

**fork** — `Module.forkScope` — a scope opened over an existing context for a module's
providers, then closed. `StartOptions.unit` is a fork the kernel opens around
every unit. See [Open a per-request scope](/how-to/open-a-per-request-scope).

**gate** — A phantom type that is inert when a composition is sound and refuses the
call otherwise. Both shipped gates are the same shape: a marker **intersected
onto a parameter**, `unknown` when sound. `start`'s is `StartGate` — one of
three sentences (`NO RUNTIME — …`, `UNSATISFIED RUNTIME PORTS — …`,
`UNSATISFIED UNIT NEEDS — …`), and the sentence prints in the error. di's is
`DependencyGate` on `Module.build`/`scoped`/`forkScope` — a one-property
object whose message ends on the missing ports:
`"UNSATISFIED DEPENDENCIES — nothing provides": Pool`. See
[start and StartOptions](/reference/core/start) and
[Compile errors, not surprises](/explanation/compile-time-wiring).

**kernel event** — One of the nine `KernelEvent`s (`building` … `uncaught`) the kernel emits
to its `EventSink`; `stderrSink` writes one JSON line each. See
[Kernel events](/reference/core/events).

**liveness / readiness** — The two probes the kernel serves itself. `/livez` is `200` in every phase
before `exited`; `/readyz` is `200` only while `serving` and not forced
unready, and once false never returns to true. See [Probes](/reference/core/probes).

**module** — `Module(name)({ imports, provides, exports })` — the unit of composition in
di: what it brings in, what it builds, what it lets out. Its type carries its
exports, its error channel and its unmet needs. See [Modules](/reference/di/modules).

**need** — A dependency a module has not satisfied itself, carried in its type. `Scope`
and `Env` are the two the kernel discharges. See [Modules](/reference/di/modules).

**port** — `class Logger extends Port("Logger")<Service> {}` — a nominal name for a
service, the vocabulary an application defines. `RuntimePort` is the one the
kernel resolves its runtime from. See [Ports](/reference/di/ports).

**pre-drain delay** — Beat 2 of the drain: `preDrainDelayMs` (default `5_000`) between readiness
flipping false and the runtime being told to stop accepting — the window
Kubernetes' eventually-consistent endpoint removal needs. See
[Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes).

**provider** — `Provider(port)(deps, arm)` — how a port's service is built: `value`,
`sync`, `make`, `class` or `acquire`/`release`. See [Providers](/reference/di/providers).

**runtime** — The service behind a port declared over `RuntimePort`: `{ name, resolves,
start }`, where `start` returns a `Serving`. A process boots exactly one. See
[The Runtime contract](/reference/core/runtime) and
[One process, one runtime](/explanation/one-process-one-runtime).

**scope** — The lifetime a graph is built and torn down in — `Module.scoped` opens one,
runs a callback, and closes it on every path, running finalisers in reverse.
`Scope` is also the phantom need an `acquire`/`release` provider adds. See
[Scopes and resource safety](/explanation/scopes-and-resources).

**sink** — Two of them, and they are not the same thing. An **`EventSink`** takes a
`KernelEvent` (`stderrSink` is the default); a **`Sink`** takes a `Line`
(`jsonSink` is the default, `pinoSink` the alternative). `kernelEvents(logger)`
is the adapter that makes the first out of the second. Neither may take the
process down: a throwing one is swallowed. See [Kernel
events](/reference/core/events) and
[@btravstack/observability](/reference/observability).

**starter** — A package that brings one concern's defaults for the standard case, in the
Spring Boot sense: `@btravstack/http`, `@btravstack/temporal` and
`@btravstack/amqp` each bring a runtime, a module sugar and a
port-and-provider sugar; `@btravstack/observability` brings implementations of
the kernel's `Logger`, `Tracer` and `Meter` ports, and no runtime. See [Starters](/explanation/starters).

**structured logging** — A line whose message is a constant and whose facts are fields — `info("placing
an order", { orderId, quantity })`, not a rendered sentence — so the receiving
system groups by message and filters by field. `Attributes` is flat and
scalar for that reason, and the ambient unit's ids are added by the
implementation rather than by the caller. See [Log and
correlate](/how-to/log-and-correlate).

**trace id** — `UnitRecord.traceId` — the correlation id, defaulting to `UnitMeta.id`,
which a runtime may supply from outside the process (an `x-request-id` header,
a message id, a workflow id). Why `UnitMeta.id` must be unique per unit. It is
the field `@btravstack/observability`'s logger stamps on every line without
the caller naming it. See [The Runtime contract](/reference/core/runtime).

**unit / unit of work** — One piece of work a runtime submits through `host.run(meta, work)`: an HTTP
request, an activity attempt, a delivery. The kernel counts it towards the
drain, hands it an `AbortSignal` and an ambient record carrying that same
signal, and hands its `Result`
straight back. See [The Runtime contract](/reference/core/runtime).
