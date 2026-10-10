---
"@btravstack/outbox": minor
---

The relay prunes published rows: with `retainMs` (`OUTBOX_RETAIN_MS`) set, each
tenant's rows published longer ago are deleted on an idle sweep, at most once a
minute and a thousand at a time, pinned to the tenant like every other read.
Unset, rows are kept as before. `OutboxStore` gains `prune(tenantId,
publishedBefore, limit)`, which `prismaOutboxStore` and `memoryOutboxStore`
implement.
