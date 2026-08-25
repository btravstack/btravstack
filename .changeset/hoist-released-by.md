---
"@btravstack/core": minor
"@btravstack/temporal-worker": patch
"@btravstack/amqp-worker": patch
---

`releasedBy` is runtime-author toolkit now, exported from `@btravstack/core`.

It was duplicated verbatim in `@btravstack/temporal-worker` and
`@btravstack/amqp-worker` — identical bodies, divergent TSDoc — and any runtime
whose `Serving.drain` awaits work settling on somebody else's clock needs it.
Two copies was the last cheap moment to hoist.

```ts
drain: (signal) => releasedBy(signal, running);
```

`running`, but no later than the kernel's drain deadline. Without it,
`Serving.stop` can outlive `drainTimeoutMs` by however long that other clock
takes — Temporal's `shutdownForceTime`, a broker library's `close()`. The
losing branch's `Result` is **dropped**, which is the point: once the deadline
wins the kernel has moved on and nothing consumes the outcome. What that costs
is the runtime's own business — an un-acked AMQP delivery is redelivered, so
abandoning one repeats work rather than losing it, while a Temporal activity is
retried on another worker.

`whenAborted` stays private to `@btravstack/core`. `releasedBy` is the whole
use case, and an unqualified "wait for this signal" invites the confusion
below. Its already-aborted arm is load-bearing: `addEventListener` on an
aborted signal never fires, so without it the race would hang.

**`releasedBy` and `Clock.sleep` are not one primitive**, which the issue left
open. `releasedBy` races work against a **signal** — no duration in it at all,
so it is `Clock`-agnostic and behaves identically under
`@btravstack/testing`'s fake clock. The kernel's own drain races work against
`clock.sleep`, a **duration** on an injected clock the harness controls. They
look alike; folding them together would drag a clock into a place that has no
time in it.
