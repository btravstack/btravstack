---
"@btravstack/temporal-worker": minor
---

A Temporal piece can name its own unit module. `TemporalWorkflowActivities(contract, key)({ unit, fork: TenantUnit, sync })` forks `TenantUnit` for that piece's attempts, seeded with the validated input on `ActivityInput(contract)`, while every other piece keeps the worker-wide `unit.activity`. A worker whose activities differ in scope, such as a listing activity beside a per-tenant fan-out, no longer builds a tenant for the listing attempt. The piece's `unit:` is checked against its own module at the piece's call, the module's unmet needs reach `start`, and specs override inside it by the module's name: `overridden(root, [], { unit: { TenantUnit: [...] } })`.
