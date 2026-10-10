---
"@btravstack/outbox": minor
---

The relay prunes published rows: with `retainMs` (`OUTBOX_RETAIN_MS`) set, each
tenant's rows published longer ago are deleted on an idle sweep, at most once a
minute and a thousand at a time (a second apart while batches come back full),
pinned to the tenant and holding its lock like a claim.
Unset, rows are kept as before. `OutboxStore` gains `prune(tenantId,
olderThanMs, limit)`, measured on the store's own clock,, which `prismaOutboxStore` and `memoryOutboxStore`
implement.
