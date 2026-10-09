---
"@btravstack/outbox": minor
---

`prismaOutboxStore` pins each tenant before it reads or marks, transaction-
locally, so the outbox table may carry `@@rls` like any tenant-owned table and
the relay may connect as a non-owner, `NOBYPASSRLS` role. The setting defaults
to `app.tenant_id` (`tenantSetting`), and on a table without row security the
pin changes nothing. The health check's `oldestPending` now reads each tenant
pinned, on one connection. `columns` names the physical columns of a model
mapped with `@map`.
