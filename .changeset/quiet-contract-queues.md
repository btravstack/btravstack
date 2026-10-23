---
"@btravstack/temporal-worker": patch
---

Scope Temporal activity-piece DI identities by the contract task queue so separate workers can reuse activity keys without collisions. Preserve wire names and uncovered-activity checks.
