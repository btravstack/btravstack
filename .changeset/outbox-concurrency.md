---
"@btravstack/outbox": minor
---

`outbox()` takes `concurrency`, which pins `OUTBOX_CONCURRENCY` (default `4`): at most that many tenants hold a claim or a prune — each a pooled connection, a claim inside a transaction across its batch's publishes — at once, and the rest wait their turn in order. Previously every configured tenant could claim at the same moment, so as many busy tenants as the pool has connections (10, `pg`'s default) starved a publisher sharing that pool. A stop answers a tenant still waiting for a slot at once; release waits only for the batches in flight.
