---
title: Why btravstack?
description: What the kernel is, what it deliberately is not, and what it gets right that a hand-written main.ts gets wrong.
---

# Why btravstack?

> **Explanation.** This page is about _understanding_ — why the kernel exists,
> where its edges are, and what was rejected. To get your hands on it first,
> start with the [Getting started tutorial](/tutorial/getting-started); for the
> surface itself, see [`start` and `StartOptions`](/reference/core/start).

`@btravstack/core` is an **application kernel**. It takes a
[`@btravstack/di`](/reference/di/modules) module whose wiring has already been
proven, builds it once, hands the graph to one runtime, drains in-flight work
when the process is told to stop, and closes the application scope on every
path out. It owns three things — the lifecycle state machine, the unit-of-work
registry and the `Runtime` contract — and nothing else. It knows nothing about
HTTP, AMQP or Temporal.

That sentence is the whole design. Everything below is what follows from
holding it.

## `di` proves the graph; `btravstack` owns _when_

`di` answers "does this composition hold together?" before the process
exists: a missing provider, a private port reached across a module boundary, a
runtime whose ports the root does not export — each is a compile error at the
call site (see [Compile errors, not
surprises](/explanation/compile-time-wiring)). By the time `start` sees a
module there is nothing left to discover about it.

So **`btravstack` does not wire**. It decides when the already-proven graph is
constructed and when it is torn down. Construction is `Module.scoped`; teardown
is the scope closing; between the two sits the runtime, serving. The kernel is
DI initialisation plus lifecycle, and it deliberately stops there.

## What it is not

Three things it is easy to mistake it for.

**Not NestJS's `NestFactory.create`.** In Nest, `create(AppModule)` _is_ the
wiring step: decorator metadata is read at runtime, tokens are resolved, the
injector graph is built, and a missing dependency throws at boot. Here that
work is done by the type checker before the process starts, so there is no
equivalent step for `start` to perform. The accepted cost is that there is no
auto-discovery — a provider and its dependency array are written out, and that
array is what buys the compile-time checking.

**Not Effect's runtime.** Effect owns how your code _runs_: fibers,
interruption, `Layer`, a program written as `Effect` values and interpreted by
a runtime. `btravstack` owns none of that. A use case here is a plain function
returning an `unthrown` `Result`; the kernel never sees inside it. What the
kernel owns is the _process_ around your code — signals, readiness, the
drain, the exit code — which is precisely the part an effect system leaves to
you.

**Not a framework.** There is no router, no ORM, no validation layer, no
logger, no middleware chain **in the kernel**. Everything of that kind arrives
as a [starter](/explanation/starters) — `@btravstack/http-server`,
`@btravstack/temporal-worker` and `@btravstack/amqp-worker`, each a module that provides a
runtime on a port the kernel resolves, and
[`@btravstack/observability`](/reference/observability), which provides a
`Logger` and no runtime at all. A starter is opinionated about its one concern
and brings nothing else; the kernel still takes no logger dependency and emits
[events](/reference/core/events) instead. Its public surface is small enough
to hold in your head, and it is meant to stay that way.

## What a hand-rolled `main.ts` gets wrong

Every backend process has a `main.ts`, and most of them contain some version of
`process.on("SIGTERM", () => server.close(() => process.exit(0)))`. That line
is wrong in four separate ways, and each one is a thing the kernel exists to
own.

**The drain.** Kubernetes removes a pod from its endpoints _eventually_, not
atomically with SIGTERM. A process that stops accepting the instant the signal
lands rejects requests the ingress is still routing to it. The kernel flips
readiness first, waits a pre-drain delay, and only then tells the runtime to
stop accepting — and gives in-flight work a deadline after that. The whole
sequence, and why each beat is where it is, is on [Draining, in three
beats](/explanation/draining-in-three-beats).

**The probes.** A liveness or readiness endpoint that lives on the
application's HTTP port answers from the transport, not from the process's
actual state — and a Temporal worker has no HTTP port to put it on. The
kernel runs its own probe server, answering `/livez` and `/readyz` from the
lifecycle state machine, on a port of its own, up before the graph is built.

**Teardown on every path.** The database pool has to be released whether the
process stopped on a signal, on a runtime that refused to start, on a
construction failure or on an uncaught exception. Hand-rolled shutdown handles
the path its author thought of. `Module.scoped` closes the scope on all of
them, and a finaliser that fails is collected into the exit report rather than
allowed to mask why the process stopped.

**The exit code.** `process.exit(0)` truncates pending output, and — the less
obvious half — installing an `uncaughtException` handler at all suppresses
Node's default exit code of `1`, so a process that crashes can report success
to its orchestrator. `runMain` sets `process.exitCode` in exactly one place
from a small table, and `70` for a crash exists precisely to close that hole.
See [Nothing throws](/explanation/nothing-throws).

## The aim

The kernel is one piece of a stack with a stated goal: **you write business
code, the framework owns the plumbing, and the type checker is what you
trust**. A composition root that forgets its runtime is a compile error naming
what is missing, not a boot-time crash. Configuration is a provider bound from the environment and
validated once, not a string read at call time. A per-request scope is an
option the kernel forks around every unit, not a `forkScope` call in every
handler.

The model for the extensibility half is Spring Boot: an opinionated default
for the standard case, configurable where a deployment differs, and a
starter per transport that brings the one way that transport is done here.
Being opinionated is what makes the surface small; being extensible through
ordinary di modules is what keeps it from being a cage.

## The family

`btravstack` sits on three packages and under four more.

- [`unthrown`](https://github.com/btravstack/unthrown) — errors as values, with a
  separate defect channel. Every fallible surface here returns its `Result`;
  nothing throws to a caller.
- [`@btravstack/di`](/reference/di/ports) — the container: ports, providers,
  modules, and the gates that make a bad composition a compile error.
- [`@btravstack/config`](/reference/config) — the environment as a port, and
  configuration as providers bound from it.
- [`@btravstack/core`](/reference/core/start) — this kernel.
- [`@btravstack/http-server`](/reference/http-server), [`@btravstack/temporal-worker`](/reference/temporal-worker),
  [`@btravstack/amqp-worker`](/reference/amqp-worker) — the starters, one per transport.
- [`@btravstack/testing`](/reference/testing) — the test harness, a dev
  dependency: a fixture that boots and stops what a test starts, a tap into
  the running graph, an in-memory runtime and a fake clock.

The three below `core` are its **peer dependencies**, not dependencies: port
identity and `isResult` both compare across copies, so an application must
hold exactly one of each. The kernel itself depends on `node:` builtins only —
see [Peer dependencies](/explanation/peer-dependencies).

## Side by side

|                    | NestJS                                       | Effect                                 | hand-rolled `main.ts`    | `di` + `btravstack`                                       |
| ------------------ | -------------------------------------------- | -------------------------------------- | ------------------------ | --------------------------------------------------------- |
| Wiring checked     | at boot, from decorator metadata             | at compile time, through `Layer` types | not at all               | at compile time, at the `Module` and `start` call         |
| Missing dependency | boot-time exception                          | compile error                          | `undefined` at call time | compile error                                             |
| Failures           | thrown, caught by filters                    | typed error channel of `Effect`        | thrown                   | `unthrown` `Result`; the kernel never throws              |
| Stop on SIGTERM    | `enableShutdownHooks()` + `app.close()`      | fiber interruption, `Scope` release    | `server.close()`         | readiness off, pre-drain delay, deadline, abandoned count |
| Probes             | `@nestjs/terminus`, on the app's HTTP routes | none                                   | a route you write        | the kernel's own server, from the state machine           |
| Exit code          | not set                                      | non-zero on failure                    | `process.exit(0)`        | `runMain`'s table, via `process.exitCode`                 |
| Transport          | built in (Express/Fastify adapters)          | `@effect/platform`                     | whatever you import      | a starter module providing a `Runtime` port               |
| Per-request scope  | request-scoped providers bubble up the chain | `Layer` per request, by hand           | closures                 | `StartOptions.unit`, forked by the kernel                 |

The row that matters most is the first: everything else the kernel does is
only safe because nothing about the graph is left to find out at boot.

## Where to go next

- The first thesis, and the one the rest hang off:
  [One process, one runtime](/explanation/one-process-one-runtime).
- The decisions that shaped the surface, each with what it ruled out:
  [Design decisions](/explanation/design-decisions).
