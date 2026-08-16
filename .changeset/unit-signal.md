---
"@btravstack/core": minor
"@btravstack/temporal": patch
"@btravstack/amqp": patch
---

**`UnitRecord` gains `signal: AbortSignal`** — the ambient record is five
fields now, not four. It is the **very** controller the unit's work callback is
handed, not a copy: one abort, two ways to reach it, fired at the drain
deadline or at once on a path that skips the drain.

The gap it closes: a middleware-shaped runtime opens its unit around a call it
does not own the arguments of. `@btravstack/temporal`'s `activityUnits` and
`@btravstack/amqp`'s `messageUnits` both hand the kernel a work callback that
_is_ the library's `next()`, so an activity or a handler had no parameter to
receive the signal through and the kernel's `drainTimeoutMs` was unobservable
from inside the work. Injecting a context the transport's contract does not
type was the alternative, and it is exactly the hidden-dependency shape `di`
exists to prevent, so the signal travels on the record instead — data about
this unit, like `deadline`, with nothing to substitute in a test.
`@btravstack/http` is unchanged: it still passes the same signal as its
handler's third parameter.

What each transport does with it is the transport's own business, and both
examples are worked:

- **`examples/order-amqp-worker`** answers a `RetryableError` when
  `currentUnit()?.signal.aborted`, leaving the delivery un-acked so the broker
  hands it to the next worker. This transport has no cancellation of its own —
  a redelivery is recovery, not cancellation.
- **`examples/order-temporal-worker`**'s `ShippingService.arrange` fails as a
  **defect**, which the platform retries on another worker. The contract's
  `ShippingUnavailable` is a permanent no and would be the wrong error for "we
  ran out of time". Temporal's `Context.current().cancellationSignal` is a
  different clock — workflow-side cancellation, and worker shutdown after
  `shutdownGraceTime` — so the two are honoured together rather than one
  standing in for the other.
