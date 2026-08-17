---
title: One process, one runtime
description: Why a process boots exactly one runtime, why the runtime is one port rather than a list, and what a Temporal worker taught the drain.
---

# One process, one runtime

> **Explanation.** This page explains the kernel's first thesis and the design
> problems it deletes. For the contract a runtime implements, see [The Runtime
> contract](/reference/core/runtime); to write one, see [Write a
> runtime](/how-to/write-a-runtime).

The kernel knows several _kinds_ of runtime — an HTTP listener, a Temporal
worker, an AMQP consumer. **A process boots exactly one.** An `api`, a `worker`
and a `consumer` deployment are three processes booting the same application
module under a different composition root, and that is the only difference
between them.

## The runtime is one port

The mechanism is smaller than the rule. `RuntimePort` is a single di port,
`Port("Runtime")`, left generic on its service. Every runtime package declares
its own concrete port over it —

```ts
class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}
```

— so at runtime every one of them has the id `"Runtime"`, while each carries
its own `Needs` and `Info` in the type. `start` builds the graph, resolves that
one port, and drives what it finds. A module that exports no port with that id
fails on arity at the call (`NO RUNTIME`); a module that provides two runtimes
is two providers for one port id, which di reports as a wiring defect before
any factory runs. There is no `runtimes: [...]`
option, and no surface in the kernel is meant to grow one.

The type-level half is what makes the composition root honest without a
runtime option: `RuntimeInfoOf<X>` reads the runtime's `Info` back out of the
module's exports, which is how `RunningApp.runtimeInfo()` is typed from the
module alone.

## Why not plural

The obvious generalisation — a process that serves HTTP _and_ consumes a queue
— was considered and rejected, and the reason is not taste. Two runtimes in one
process force two questions the kernel would then have to answer for every
application:

- **Whose drain deadline is it?** `drainTimeoutMs` is one number. With two
  runtimes it is either shared — so a slow queue handler eats the HTTP
  server's budget — or split, and now the kernel owns a scheduling policy.
- **Whose failure takes the process down?** If the consumer's broker
  connection drops, is the API still healthy? Readiness is one boolean; the
  probe server answers one question.

With one runtime, neither question exists. Readiness is the runtime's
readiness, the drain deadline is the runtime's deadline, and a runtime that
refuses to start is a startup failure of the whole process. That is what
Kubernetes wants anyway: an `api` Deployment and a `worker` Deployment scale,
fail and roll out independently, and a pod's readiness means one thing.

The cost is that a co-located pattern — one container doing two jobs to save a
pod — is not expressible. It is meant not to be.

## The same module, three deployments

This is a claim that can be tested rather than asserted, and
[`examples/`](/examples/) is the test. One clean-architecture application —
`order-domain`, `order-application`, `order-infrastructure` — is booted by
three composition roots:

- [`order-api`](/examples/order-api) — `HttpModule("OrderApi")({ router, imports: [OrderApplicationModule, OrderPersistenceModule], … })`;
- [`order-temporal-worker`](/examples/order-temporal-worker) — `TemporalModule("OrderTemporalWorker")({ contract, activities, workflows, imports: […] })`;
- [`order-amqp-worker`](/examples/order-amqp-worker) — `AmqpModule("OrderAmqpWorker")({ contract, handlers, imports: […] })`.

The application and persistence modules are unchanged between them. The same
`DuplicateOrder` error the use case returns arrives as a typed `CONFLICT` on
the first and a `nonRetryable` typed contract error on the second; the third
is a broadcast, where a placement's `Err` never crosses the broker and only
the committed fact does — and no mapping of it exists anywhere near the
kernel, which is the subject of [The kernel maps
nothing](/explanation/the-kernel-maps-nothing).

## What a Temporal worker taught the drain

The HTTP and AMQP runtimes were easy tenants of the drain contract: told to
stop accepting, they stop, and there is nothing of their own to wait for. The
Temporal worker was the first runtime with **real drain semantics of its own**,
and it sharpened two things about `Serving.drain`.

First, `drain` became a genuine wait rather than "stop accepting, nothing left
to await". `worker.shutdown()` stops polling immediately, but the worker's
`run()` resolves only once the in-flight activity has finished — so the
runtime's `drain` has something to hold open, and the kernel's `awaitIdle()` is
sequenced _behind_ it rather than sampled alongside it (the reason is on
[Draining, in three beats](/explanation/draining-in-three-beats)).

Second, it was the first runtime that had to **honour the deadline signal**
rather than merely note it. `run()` settles on Temporal's own
`shutdownForceTime`, so an activity that never finishes would hold
`Serving.stop` well past the kernel's `drainTimeoutMs`. `@btravstack/temporal`
races `run()` against the `AbortSignal` the kernel hands `drain`, and reuses
that signal for `stop()`. There was no stronger escalation available:
`@temporalio/worker` exposes no public forced shutdown (`forceShutdown$` is
`protected`, `Runtime.shutdown()` is process-global), so "stop waiting" is the
escalation. The kernel is released on time, the work is reported `abandoned`,
and the worker keeps winding down on Temporal's clock until the process exits.

Both lessons landed in the package the example consumes, not in the kernel —
which is the point of the contract. `drain` means "stop accepting"; the
`AbortSignal` means "the kernel's deadline has passed"; the kernel owns the
accounting and never does arithmetic on the runtime's behalf, and a runtime
never does arithmetic on time.

## Where to go next

- The three beats the drain runs, and why each is where it is:
  [Draining, in three beats](/explanation/draining-in-three-beats).
- What a starter is, and why the shipped runtimes have no `needs`:
  [Starters](/explanation/starters).
