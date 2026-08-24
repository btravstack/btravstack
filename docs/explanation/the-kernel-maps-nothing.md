---
title: The kernel maps nothing
description: Why a unit's Result reaches the runtime untouched, and where each transport's own mapping — HTTP status, activity failure, ack/nack/dead-letter — actually lives.
---

# The kernel maps nothing

> **Explanation.** This page explains the kernel's third thesis — that a
> `Result` becomes a transport outcome somewhere the kernel is not. For the
> unit surface itself, see [The Runtime contract](/reference/core/runtime); to
> see each mapping in a running example, start at [the examples
> overview](/examples/).

Every runtime does the same thing in a loop: take one piece of work, run it,
produce an outcome. The kernel names that a **unit**, owns it — the count, the
`AbortSignal`, the ambient record — and hands the outcome straight back.
**Whatever `Result` a handler produces is what the runtime receives.** The
kernel observes only that the unit settled.

That is literal. `units.ts`'s `run` wraps the work in a `fromSafePromise`,
closes the unit in a `finally`, and ends in `.flatMap((result) => result)`: the
work's own `Result` is unwrapped and returned as-is, `Ok`, `Err` or `Defect`,
untouched. `RunUnit` is transparent to the work's channels by construction,
not by discipline.

## Why the kernel declines

The moment a lifecycle package knows that an `Err` tagged `NotFound` is a `404`
it has become an HTTP framework, and it will shortly know about retries,
serialisation and content negotiation too. Each of those is a real concern
with a real home; none of them is the lifecycle's. **Nothing in the kernel may
grow a status code, a retry policy or a serialisation format**, and the
package's dependency list — `node:` builtins only — is one of the things that
keeps it that way.

There is a second reason, and it is about types. A mapping in the kernel would
have to be written against _some_ error type, and the kernel does not have one:
the startup channel is the application's own `E`, passed through unwrapped
(see [Nothing throws](/explanation/nothing-throws)), and a unit's `E` is
whatever the handler said it was. The only place a mapping can be typed
against the real cases is the place that knows them — the transport boundary
of one application.

## Where each mapping lives

The three shipped starters each answer the question differently, and none of
them answers it in the kernel.

**HTTP: oRPC's `.result()` triage, in the router.** `@btravstack/http` mounts an
oRPC router and declines to map anything itself. The router's procedures are
`Result`-returning functions typed by the contract, and the one place a domain
error becomes a status is the `mapErrCases` in each procedure. From
[`examples/order-api`](/examples/order-api), whose `orders` fragment is
`authenticated`, so the tenant comes off the principal rather than the input:

<!-- doctest: skip — a mapErrCases excerpt of the router shown in full in docs/reference/http.md -->

```ts
      place: ({ errors, context }, input) =>
        place
          .execute(context.principal.tenantId, input.id, input.quantity)
          .map(view)
          .mapErrCases((matcher) =>
            matcher
              .with(P.tag("InvalidQuantity"), (error) =>
                errors.INVALID_QUANTITY({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("InvalidOrderId"), (error) =>
                errors.BAD_REQUEST({ message: error.message, data: { id: error.id } }),
              )
              .with(P.tag("DuplicateOrder"), (error) =>
                errors.CONFLICT({ message: error.message, data: { id: error.id } }),
              ),
          ),
```

The matcher has no wildcard, so a new domain error is a compile error at the
one place that has to decide what the client sees. A `Defect` rides oRPC's own
defect path and collapses to `INTERNAL_SERVER_ERROR`; the package's own
fallbacks are a `404` for a path naming no procedure and a `500` for a unit
that could not be built. Nothing else.

**Temporal: activity failure, owned by `declareActivitiesHandler`.**
`@btravstack/temporal` hands the activities record to `temporal-contract`,
which already owns `Result` → activity failure — a modeled error becomes a
typed contract error the workflow can branch on, `nonRetryable` where the
contract says so. Doing that mapping a second time in the starter is what the
removal of its earlier raw-worker path was about.

**AMQP: a three-way split, and it is not the library's alone.** Here the honest
answer is more complicated than a one-line handoff. `amqp-contract`'s dispatch
routes a modeled `RetryableError` / `NonRetryableError` against the queue's
`retry` configuration — that much the library owns. A **`Defect` is not routed
that way**: it is nacked once, immediately, straight to the dead-letter queue,
never touching the retry budget. So an infrastructure failure a handler did not
model — a database that went away — is parked on its first attempt exactly like
a permanent domain error, unless the handler recovers it itself:

<!-- doctest: skip — a recoverDefect excerpt of the handler shown in full in docs/how-to/consume-amqp-messages.md -->

```ts
          .recoverDefect((cause) =>
            ErrAsync(new RetryableError("placing the order failed", cause)),
          ),
```

That line, in `@btravstack/amqp`'s worked example, is not decoration. It is
what keeps "infrastructure comes back" true on this transport, and it belongs
to the handler because only the handler knows which of its defects are worth
retrying.

The claim that survives across all three is narrow and exact: **the kernel
maps nothing**. What each transport's mapping looks like — a status, a typed
failure, a three-way ack decision split between library and handler — is that
transport's own business, sometimes split further still.

## The unit is the seam, and it cuts both ways

Because the kernel is transparent, **in-flight tracking falls out for free**.
The kernel does not need to understand an outcome to count it: a unit is open
from `run` until its `Result` settles, whatever that `Result` is, so
`DrainReport.abandoned` is accurate with no cooperation from the runtime and
`Serving.drain` can mean only "stop accepting".

The same transparency is what makes the two contracts a runtime owes
unenforceable. The kernel sees a settled `Result` and has no idea whether
bytes are still in flight — so a runtime must flush its response _inside_ the
unit, or race `stop()` tearing the transport down. And it sees a `UnitMeta`
and cannot know whether its `id` is unique — so a runtime that passes a route
template as the id collapses every request onto one trace id, silently. Both
are stated on [Write a runtime](/how-to/write-a-runtime); `@btravstack/http`
discharges both structurally (the unit does not close until the response's
`'close'` fires; the id is a `randomUUID()` per request), which is one good
reason to consume a starter rather than hand-roll a transport.

## What was rejected

**A `mapOutcome` hook on `Runtime`.** A callback the kernel would invoke with
each unit's `Result` and the transport's reply object. It would put a
transport-shaped type into `RunUnit`'s signature and make the kernel the place
every mapping is registered — the framework the thesis exists to not become.

**A shared error-to-status table.** `NotFound` → `404`, `Conflict` → `409`,
shipped once for every transport to reuse. It would type against nothing real
(the kernel has no error type), and it would be wrong for two of the three
transports on day one: Temporal wants a typed contract error, AMQP wants a
retry decision.

**Wrapping the unit's `Err`.** A `UnitFailed<E>` around the handler's error so
the kernel could attach the `unitId`. It would erase the modeled type at
exactly the boundary that needs it most; the ambient record already carries
the id for whoever wants it.

## Where to go next

- The starters, and why the shipped runtimes resolve nothing once the router,
  activities and handlers became ports: [Starters](/explanation/starters).
- The record a handler runs inside, and who may read it:
  [Ambient data, injected capabilities](/explanation/ambient-vs-context).
