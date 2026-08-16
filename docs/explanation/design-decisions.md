---
title: Design decisions
description: The deliberate choices behind the kernel's surface — each with the reason it was made and what it rules out — so a missing feature reads as a decision rather than an oversight.
---

# Design decisions

> **Explanation.** The kernel is defined as much by what it declines as by what
> it ships. This page collects the decisions that shaped its surface, each
> with its reasoning and what it rules out. For the surface itself, start at
> [`start` and `StartOptions`](/reference/core/start).

The guiding aim is a kernel that owns three things — the lifecycle state
machine, the unit registry, the `Runtime` contract — and can be **done**. Each
entry below was weighed against that.

## The runtime is a service of the module, not an option

`start(module)` takes no `runtime` argument. The module exports a port
declared over `RuntimePort`; the kernel builds the graph, resolves that port
and drives what it finds. A runtime is therefore built by di like everything
else and reads its collaborators the same way — which is what let every
starter's `needs` go to `never`. It rules out `start(module, { runtime })`, and
with it a runtime constructed outside the graph that reaches back into it.

## The gate is a phantom rest tuple, and it is bypassable on purpose

`start`, `runMain` and `@btravstack/testing`'s `withApp` and `Boot` end in
`...gate: StartGate<X, UnitNeeds>` — empty when the module exports a runtime
whose needs its exports cover, a named error tuple (`NO RUNTIME`,
`UNSATISFIED RUNTIME NEEDS`, `UNSATISFIED UNIT NEEDS`) otherwise. A conditional type on `module` or `options` would make
TypeScript defer that parameter's inference and can collapse `X` or `E` to
`unknown`; a trailing rest tuple leaves inference alone. It is the same shape
as di's `UNSATISFIED DEPENDENCIES` gate on `Module.scoped`. A caller who
hand-writes the phantom arguments does typecheck — proved in
`start.test-d.ts`, not assumed. The gate exists to catch the accident, not to
be unforgeable, and making it unforgeable would cost the inference it protects.

## `RuntimeStartFailed` is the only error the kernel mints

Everything else on the startup channel is the application's own `E`, passed
through unwrapped. The kernel adds one `TaggedError`, `{ runtime, cause }`,
for the failures that are genuinely its own — a runtime that would not start,
a probe port that would not bind. It rules out a `KernelError` hierarchy, and a
wrapper that would erase the module's modeled type. A probe bind failure uses
`runtime: "probes"`; a bad `PROBE_PORT` is that error carrying a
`ConfigInvalid` as its `cause`, so `exited`'s error union stays the same width
for every caller and `runMain` reads the `78` one level down.

## `Serving.drain` returns no report

It returns `AsyncResult<void, never>`, and the `AbortSignal` it receives is
the only thing it learns about time. Only the kernel can see the unit registry,
so only the kernel can count; a runtime reporting its own numbers would be a
second source of truth for the field the exit code reads. It rules out a
runtime doing arithmetic on the deadline, and a `DrainReport` that two parties
disagree about.

## `Info` is the runtime's own shape, not a port number

`Serving.info` and `RunningApp.runtimeInfo()` exist so a runtime that bound
`port: 0` can say which port it got. Modelling that as `port: number` was the
obvious design and would have been wrong the day the second runtime shipped: a
queue consumer has no port and publishes `{ queue, prefetch }`. `Info` defaults
to `never`, so a runtime with nothing to say omits it and both types read as
they did before the field existed. It rules out an `onListening` hook per
runtime.

## `UnitMeta.id` is unique per unit, or the runtime supplies `traceId`

`traceId` defaults to `meta.id`, and stays optional because `id` genuinely _is_
a correct trace id whenever it is already unique — a message id, a job id —
which is the common case. Requiring it would not help: the kernel cannot verify
uniqueness without remembering every id it has seen, so the obligation would be
syntactic, and `traceId: routeTemplate` types as well as the bug it replaces.
The defect was the unstated contract, not the default. `UnitRecord.unitId` is
minted and always unique for readers that only need to tell units apart.

## The probe server binds before the graph is built

`/livez` answers from `building` onward, so a slow-building graph is covered
without a separate startup probe. It binds `127.0.0.1` only and is `unref`'d,
so it never keeps the event loop alive; a bind failure is a startup failure
that stops the graph being built at all. `PROBE_PORT` is therefore the one
piece of configuration the kernel binds itself — through the same
`Config.port` field the public API ships — because the graph that would
otherwise carry it does not exist yet.

## The `teardownErrors` aliasing is load-bearing

The array on the `ExitReport` is the **same mutable array** the scope's
`onTeardownError` pushes into. di closes the scope after `use` settles but
before its own result settles, so every finaliser failure lands after the
report object is built and before a caller can observe it. A defensive copy
anywhere on that path would silently drop every teardown error — which is why
the comment guarding that line survives the repository's sparse-comment rule.

## `ready()` is a one-way latch, and it is on `RunningApp` for one path

`ready()` is `phase === "serving" && !forcedUnready`, and the two terms do not
contribute equally. On the drain path the phase alone answers false. The latch
is load-bearing on exactly one path — the uncaught one, where the handler
flips it while the phase is still `"serving"`, a window no HTTP round trip
fits inside. That is why `ready()` is exposed at all: it is the synchronous
read of the predicate `/readyz` answers from, and what an embedder wires into a
health endpoint of its own with `probes: false`.

## `runMain` sets `process.exitCode`, never calls `process.exit()`

Pending output flushes, an embedding host keeps control of its own lifetime,
and a test can observe the code without the run ending. It rules out
`start` deciding anything about the process — `runMain` is the one place, and
even it only sets a number. See [Nothing throws](/explanation/nothing-throws).

## Hono went; oRPC's node adapter stayed

`@btravstack/http` once routed through Hono to oRPC's fetch adapter. A review
found Hono was routing exactly one pattern and `404`ing the rest — which
`@orpc/server/node`'s `RPCHandler.handle(req, res, { prefix })` and the
runtime's own `404` do with two dependencies fewer, and without an
`overrideGlobalObjects` footgun to disarm. It rules out a "bring your own
router" option: oRPC is the one way, and the listener port is internal.

## The starter sugars name nothing

`HttpRouter(contract)(deps, arm)`, `TemporalActivities(contract)(deps, arm)`
and `AmqpHandlers(contract)(deps, arm)` take no port name: each returns di's
`Provider(port)` on a port the starter owns and declares once —
`Port("HttpRouter")`, `Port("TemporalActivities")`, `Port("AmqpHandlers")` —
the way it owns `HttpConfig` or `HttpRuntime`. A process serves one router,
one activities record, one handlers record as it boots one runtime, so there
is nothing to tell apart and a name would only be a second thing to keep in
step; two providers for the port in one graph are di's duplicate-provider
defect at build, which is the right answer. For Temporal and AMQP the port is
one id at the value level and typed per contract at the type level — the move
the kernel's `RuntimePort` makes — so a provider built for one contract still
cannot be handed to a `TemporalModule` / `AmqpModule` declaring another; the
check moved from a name to the record's own shape. It rules out a `router` /
`activities` / `handlers` option on `http()` / `temporal()` / `amqp()` — the
primitives simply **need** the port — and a per-application port class for
what the starter consumes. `Config.provider("Name")(schema)` keeps its name
on purpose: several config slices per application is normal, and the name is
what `ConfigInvalid` prints.

## The logger is a port, and the package is named for observability

`Logger` is a di port over a deliberately narrow service — `with` returns a
new logger, `Attributes` is a flat record of scalars, a failure has its own
`cause` channel, there are six levels and no more, and a log call cannot
throw. It is the **framework's** port rather than each application's, because
the framework logs too (`kernelEvents`) and one port has to serve both. The
package is `@btravstack/observability`, not `@btravstack/logger`, because
logs, traces and metrics share a correlation id, a resource, a configuration
slice and a flush-on-shutdown lifecycle; two packages would duplicate all
four, and the second would end up depending on the first. **Traces and metrics
are not shipped** — the name is the seam, not a claim.

It rules out a `@btravstack/logger` package that a tracing package would then
have to import; a class you `new`, with the static instance and the
`useLogger` escape hatch that reach past DI; `any` varargs and printf, and
with them a logger that stringifies whatever it is handed — which is how a log
call becomes the thing that throws; a mutable `setContext`, whose one instance
two request scopes interleave; and a vitest-style global that a test cannot
replace by composing a different module. Correlation is ruled **in** on the
same grounds: `createLogger` reads `currentUnit()` per call, so no signature
anywhere carries a trace id. See
[`@btravstack/observability`](/reference/observability).

## `Config` is a hand-rolled Standard Schema

`Config.object` speaks Standard Schema v1 so any `zod` / `valibot` / `arktype`
schema is accepted where it is — but the fields themselves are hand-rolled,
because `@btravstack/config` and the kernel depend on nothing beyond their
peers. It rules out a schema library in the framework's own dependency tree,
while keeping the door open for an application that already has one.

## Peers, not dependencies

`unthrown`, `@btravstack/di` and `@btravstack/config` are peer dependencies
of the kernel; a starter's libraries (`@orpc/server`, `@temporalio/worker`,
`@amqp-contract/worker`) are peers of that starter. Port identity and
`isResult` both compare across copies, so an application must hold exactly
one of each; and bundling `@amqp-contract/worker` was measured at two orders
of magnitude of dist size. It rules out the convenience of `pnpm add
@btravstack/core` alone. See [Peer dependencies](/explanation/peer-dependencies).

## The test harness is a package

`@btravstack/testing` is where `withApp`, `testRuntime`, `createFakeClock`,
`bootFixture` and `tapped` live — a package of its own, the way
`@nestjs/testing` is, and a dev dependency peering on `core`, `config`, `di`
and `unthrown`. It replaced `@btravstack/core/testing`, a second entry point
of the kernel. The entry point kept the fakes out of a production bundle,
which a separate package does equally well; what it could not do was grow.
The example suites had each hand-rolled the same two things — a `start(...)`
followed by `stop(); expect(exited).toBeOk()` in a fixture's teardown, because
a callback harness like `withApp` cannot be handed to `test.extend`'s `use()`,
and a `LoggerTap` / `ServicesTap` provider written only to reach a service of
the running graph — and a harness that grows belongs beside the kernel, not
inside it. It rules out `@btravstack/core/testing` (gone, unreleased), a
`vitest` peer anywhere in the family — `bootFixture` is a plain `(ctx, use)
=> Promise<void>`, vitest's fixture protocol met without the import — and the
kernel keeping any test double of its own: its specs consume the package like
everyone else. It also rules out a `@btravstack/testing/vitest` subpath: the
fixture imports nothing from vitest, so there is nothing runner-specific to
isolate, and a runner with the same `use` shape takes it as it is.

## `Config.boolean` was removed

It had no consumer: no starter binds a boolean, no example reads one. Surface
without a reader is surface that drifts, so it went. Add it back the day a
starter or an example needs it, with that need as its test.

## `preDrainDelayMs` is 5 s and `drainTimeoutMs` is 20 s

Five seconds is the budget for Kubernetes endpoint propagation to catch up
with readiness going false; twenty sits deliberately under the 30 s default of
`terminationGracePeriodSeconds`, leaving headroom for `stopping` before SIGKILL. Raise one and you
must raise the other. The reasoning is on [Draining, in three
beats](/explanation/draining-in-three-beats); the numbers are defaults, and
`StartOptions` takes both.

## The drain deadline aborts, and "stop waiting" is the escalation

When the kernel's deadline passes, the `AbortSignal` handed to `Serving.drain`
fires and every open unit's signal fires. There is no stronger step, and the
Temporal runtime is where that was tested: `@temporalio/worker` exposes no
public forced shutdown (`Worker.forceShutdown$` is `protected`,
`Runtime.shutdown()` is process-global), so `@btravstack/temporal` races
`run()` against the signal and stops waiting. The kernel is released on time,
the work is reported `abandoned`, and the worker keeps winding down on
Temporal's clock until the process exits. It rules out the kernel ever calling
`process.exit()` to enforce a deadline.

## What there deliberately is not

No `Defect` constructor, no `overrideProvider`, no accumulation of runtimes,
no `recoverFailure`-style channel-moving helper. Swapping an adapter is
composing a different module, which di already documents and the type checker
already verifies. Two more are deferred rather than declined: a lint rule
banning `currentUnit()` outside adapters (it needs a convention for
identifying an adapter), and a `docs-examples.test-d.ts` for the three
starters (three packages' worth of samples did not yet justify the harness).

## Where to go next

- The thesis most of these decisions protect:
  [One process, one runtime](/explanation/one-process-one-runtime).
- The failure model the error-channel decisions produce:
  [Nothing throws](/explanation/nothing-throws).
