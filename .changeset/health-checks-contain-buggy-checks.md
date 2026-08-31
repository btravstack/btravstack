---
"@btravstack/core": patch
---

`/healthz` contains a buggy health check instead of amplifying it.

A check whose `AsyncResult` defected propagated through `runHealthChecks`, so
the probe server's response was never written — the request hung, and the
defect was discarded unlogged. A check that threw synchronously escaped the
fold, the request listener, and landed in the kernel's own `uncaughtException`
handler: a whole-application teardown over a fault in the health endpoint,
the exact outcome the probe server's `'error'` listener exists to prevent.

Each check is now started inside the pipeline, and a throw or defect is
recovered into an unhealthy component line naming its cause — exactly like a
check that failed properly, and with every sibling component still reported.
