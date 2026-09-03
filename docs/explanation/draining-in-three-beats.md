---
title: Draining, in three beats
description: Why a graceful drain flips readiness first, sleeps before it stops accepting, gives in-flight work a deadline, and reports what it abandoned.
---

# Draining, in three beats

> **Explanation.** This page explains the kernel's fifth thesis — the shape of
> a drain and the reasoning behind every beat. For the numbers to set and how,
> see [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes);
> for the report's fields, see [`ExitReport` and
> `DrainReport`](/reference/core/exit-report).

A drain is three beats, in an order that is the whole point:

1. **Readiness flips false**, and the unit counts are sampled — synchronously,
   before anything else.
2. The kernel **waits `preDrainDelayMs`** (default `5_000`) before telling the
   runtime to stop accepting.
3. In-flight work gets **`drainTimeoutMs`** (default `20_000`) to finish;
   whatever is still open at the deadline is aborted and reported `abandoned`.

Beat 2 looks like a pointless sleep. It is the most valuable line in the
package.

```text
SIGTERM, with the process already serving
  │
  ├─ 0 ms ── beat 1 ──────────────────────────────────────────────────────────
  │          /readyz → 503, in-flight sampled          (synchronous, no await)
  │          the endpoint controller starts removing this pod
  │
  ├─ beat 2 ── PRE_DRAIN_DELAY_MS, default 5 000 ─────────────────────────────
  │          ░░░░░░░░░░  still accepting, on purpose
  │          the window where the ingress may still route here
  │
  ├─ beat 3 ── DRAIN_TIMEOUT_MS, default 20 000 ──────────────────────────────
  │          ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  Serving.stop, then in-flight work finishes
  │          anything still open at the deadline: aborted, counted `abandoned`
  │
  ├─ stopping ── Serving.stop, then the application scope closes ─────────────
  │          the runtime finishes closing on its OWN clock here — a broker's
  │          close, a worker's shutdown — and finalisers run, LIFO; failures
  │          land in ExitReport.teardownErrors
  │
  └─ exited ── exit 0 clean, 2 if anything was abandoned or a teardown failed
             │
             └── SIGKILL waits here, at terminationGracePeriodSeconds (30 s by
                 default) — which is why 5 + 20 leaves five seconds in hand
```

The two durations are variables a deployment sets (`PRE_DRAIN_DELAY_MS`,
`DRAIN_TIMEOUT_MS`) and must stay under `terminationGracePeriodSeconds`, which
is Kubernetes' own; the exit codes are the kernel's, not configuration. And the
figure assumes the signal found the process **serving** — one that lands
mid-build is buffered, and beat 2 then pays only what is left of the delay
(below). The rest of this page is why each beat is where it is.

## Beat 1 — readiness first, and sample now

The instant a shutdown is requested, `/readyz` starts answering `503`, and
`inFlightAtStart` is read off the registry. Both happen in the same
synchronous turn, before any `await`, and the order matters twice.

Readiness first, because the whole sequence is a conversation with an
orchestrator: "stop sending me traffic" has to be said before "I have stopped
listening", or the second arrives as connection refusals. Sample now — not
after the delay — because a unit that opens or closes _during_ the delay would
otherwise shift the report's baseline under it, and the `draining` event
emitted from the same turn would carry a different number from the report.

## Beat 2 — the delay closes a window Kubernetes leaves open

**Kubernetes endpoint removal is eventually consistent.** When a pod is
terminated, SIGTERM is delivered to the container and, in parallel, the pod is
removed from its Service's endpoints — but the kube-proxy and ingress
controllers that route traffic learn about that removal on their own schedule.
For a window after the signal, a pod that has already stopped accepting is
still receiving requests the ingress believes it can serve, and each of those
is a connection refused at the worst possible moment: during a routine roll
out.

The pre-drain delay is that window, made explicit. Readiness went false in
beat 1, so the endpoint controller has been told; the delay is the time it
takes for everyone downstream to hear. Only then is the runtime told to stop
accepting. Shipping this as a _default_ — rather than as a paragraph in a
deployment guide — is worth more than most of the framework, because it is the
fix nobody adds until the first roll out that dropped requests.

The delay is charged from when the shutdown was **requested**, not from when
the kernel got round to noticing. A signal that lands mid-build is buffered
until the runtime is serving; if the delay were then paid in full, the
process would pay for a window construction had already spent, and delay plus
build can exceed the grace period below. So the sleep is
`max(0, preDrainDelayMs − sinceShutdownRequested)`.

## Beat 3 — a deadline, and an honest count

Once the runtime has been told to stop accepting, in-flight work has
`drainTimeoutMs` to finish. The timeout races two things chained together —
the runtime having stopped, _then_ the registry going idle — and never awaited
on its own, so a runtime whose `drain` never resolves cannot hold the process
past the deadline. When the race settles, whichever branch won, the
`AbortSignal` handed to `Serving.drain` is aborted, so a runtime that treats
it as its cue to return is released too.

The chaining is deliberate and was found the hard way. `awaitIdle()` answers
about the registry at the instant it is _called_, returning at once when
nothing is open. Sampling it in the same tick the runtime was told to stop
would let a unit that opens while `drain` is still resolving go unwaited, then
be aborted and reported abandoned with the entire budget unspent. For a
runtime whose `drain` is a real wait — an HTTP server retiring keep-alive
connections, a Temporal worker finishing an activity — that window is wide. So
`awaitIdle` is **sequenced behind** the runtime's `drain`, never alongside it.

At the deadline, whatever is still open is aborted through each unit's
`AbortSignal` — the one the kernel handed the work callback, and the one on
the unit's ambient record as `currentUnit()?.signal`, which are the same
object. Two routes matter because the callback is not always where the work
is: a middleware-shaped runtime hands the kernel a callback that is the
library's own `next()`, so a Temporal activity or an AMQP handler has no
parameter to receive a signal through and reads it off the record instead.
Whatever is aborted is then counted:

```ts
type DrainReport = {
  readonly inFlightAtStart: number;
  readonly completed: number;
  readonly abandoned: number;
};
```

`abandoned` is the field the exit code keys on. `completed` is a delta of a
**monotonic** closed-count, not `inFlightAtStart − abandoned` — so it may
exceed `inFlightAtStart` when in-flight work spawned more units during the
drain. That is honest reporting: the obvious formula goes negative the moment
a unit starts after the sample and closes before the deadline, and a report
that can say `-1` is not a report.

## A stream is a unit, and the runtime ends it

A server-sent-events response is a unit like any other: it opened when the
request arrived and closes when the response does. Left alone, it would sit
through the whole in-flight budget, be aborted at the deadline, and be
reported `abandoned` — an exit code `2` on every deploy for an application
with one subscriber.

So `@btravstack/http-server` ends it itself, at beat 3's start. When the
kernel calls `Serving.drain`, the runtime walks its open responses, and one
whose content type is `text/event-stream` is **reset**. That is the one
moment a reconnect is free: readiness has been false since beat 1, beat 2
gave the ingress time to hear it, and the client's reconnect lands on a
replica that is staying, carrying `Last-Event-ID`. The unit closes on the
response and is counted `completed`.

A reset and not a clean end, by measurement. oRPC's client reads a clean
end as the iterator finishing and stops for good; both it and a browser's
`EventSource` treat a reset as "reconnect". The application's own `finally`
still runs, through oRPC's signal, which the reset aborts.

This is transport semantics inside the runtime's own `drain`, not a fourth
beat — the same shape as the Temporal worker's `shutdown()`. Every server
surveyed (Go's `net/http`, hyper, Spring Boot, Node's `server.close()`)
counts a stream as in flight and leaves closing it to the application;
graphql-ws is the one library that closes them itself, with `1001 Going
Away`. The SSE specification makes reconnection the client's default, so
shipping the close as a default costs the client nothing it was not built
for. The recipe is [Stream with server-sent events](/how-to/stream-with-server-sent-events).

## Why 5 and 20

`preDrainDelayMs` at 5 s is the budget for endpoint propagation to catch up
with beat 1. `drainTimeoutMs` at 20 s sits **deliberately under**
Kubernetes' `terminationGracePeriodSeconds` default of 30 s: after the drain
comes `stopping` — the runtime's `stop()`, the scope closing, finalisers
releasing pools — and that needs headroom before SIGKILL arrives and takes
whatever it finds. Raise one and you must raise the other, and a runtime that
keeps a deadline of its own (Temporal's `shutdownForceTime`) has to sit at or
under the kernel's too.

## Only a signal drains

`stop()` and an uncaught exception both go **straight to `stopping`**, and
`ExitReport.drain` is `undefined` for both. The two skips have different
reasons.

`stop()` is a deliberate, programmatic stop — a test, an embedder — with
nothing to wait out on an orchestrator's behalf. **An uncaught exception skips
the drain because the process state may be corrupt.** After an uncaught throw
there is no way to know what invariant was left half-updated, and draining
in-flight work risks completing it _wrongly_. Half-finished correct work beats
confidently-wrong finished work — so readiness is forced false, in-flight
units are aborted at once, and the process goes to `stopping`. Skipping the
drain is a decision not to _wait_ for that work, not a decision to leave it
running: on both non-signal paths the registry is aborted immediately, so
nothing keeps completing against the state the skip exists to protect, and no
unit holding a socket keeps the event loop alive after the report.

**A second signal skips the drain too.** A double Ctrl-C in development, an
operator's escape hatch in production: the same `AbortController` cuts short
whichever of the two sleeps is pending, and the process moves on.

## What was rejected

**Draining on `stop()`.** A drain is a conversation with an orchestrator, and
`stop()` has no orchestrator on the other end. Making it drain would cost
every test the full delay for nothing.

**Letting the runtime report the drain.** `Serving.drain` returns `void`, not a
`DrainReport`. Only the kernel can see the registry, so only the kernel can
count; a runtime that reported its own numbers would be a second source of
truth for the field the exit code reads. The runtime is told two things —
"stop accepting", and, through the signal, "the deadline has passed" — and
does no arithmetic on time.

**Draining after an uncaught exception, but carefully.** There is no careful
version. The kernel does not know what broke.

## Where to go next

- What the exit code says about a drain, and why a crash outranks abandoned
  work: [Nothing throws](/explanation/nothing-throws).
- The runtime whose drain has real semantics of its own:
  [One process, one runtime](/explanation/one-process-one-runtime).
