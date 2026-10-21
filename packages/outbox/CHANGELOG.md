# @btravstack/outbox

## 0.45.0

### Patch Changes

- @btravstack/config@0.45.0
  - @btravstack/core@0.45.0
  - @btravstack/di@0.45.0

## 0.44.1

### Patch Changes

- @btravstack/config@0.44.1
  - @btravstack/core@0.44.1
  - @btravstack/di@0.44.1

## 0.44.0

### Patch Changes

- @btravstack/config@0.44.0
  - @btravstack/core@0.44.0
  - @btravstack/di@0.44.0

## 0.43.0

### Patch Changes

- @btravstack/config@0.43.0
  - @btravstack/core@0.43.0
  - @btravstack/di@0.43.0

## 0.42.0

### Patch Changes

- @btravstack/config@0.42.0
  - @btravstack/core@0.42.0
  - @btravstack/di@0.42.0

## 0.41.0

### Patch Changes

- @btravstack/config@0.41.0
  - @btravstack/core@0.41.0
  - @btravstack/di@0.41.0

## 0.40.0

### Patch Changes

- @btravstack/config@0.40.0
  - @btravstack/core@0.40.0
  - @btravstack/di@0.40.0

## 0.39.1

### Patch Changes

- Updated dependencies [1c3e10b]
  - @btravstack/core@0.39.1
  - @btravstack/config@0.39.1
  - @btravstack/di@0.39.1

## 0.39.0

### Patch Changes

- @btravstack/config@0.39.0
  - @btravstack/core@0.39.0
  - @btravstack/di@0.39.0

## 0.38.0

### Patch Changes

- @btravstack/config@0.38.0
  - @btravstack/core@0.38.0
  - @btravstack/di@0.38.0

## 0.37.0

### Patch Changes

- @btravstack/config@0.37.0
  - @btravstack/core@0.37.0
  - @btravstack/di@0.37.0

## 0.36.0

### Patch Changes

- @btravstack/config@0.36.0
  - @btravstack/core@0.36.0
  - @btravstack/di@0.36.0

## 0.35.1

### Patch Changes

- @btravstack/config@0.35.1
  - @btravstack/core@0.35.1
  - @btravstack/di@0.35.1

## 0.35.0

### Patch Changes

- @btravstack/config@0.35.0
  - @btravstack/core@0.35.0
  - @btravstack/di@0.35.0

## 0.34.0

### Minor Changes

- 9366004: Add `outboxRuntime()` and `OutboxRuntime` for standalone relay processes using `runMain`, kernel probes, deadline-aware drain and scope teardown. Keep `outbox()` for embedded relays.

### Patch Changes

- @btravstack/config@0.34.0
  - @btravstack/core@0.34.0
  - @btravstack/di@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [f5ae34d]
- Updated dependencies [f690c1c]
  - @btravstack/di@0.33.0
  - @btravstack/core@0.33.0
  - @btravstack/config@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [edbd7a3]
  - @btravstack/core@0.32.0
  - @btravstack/config@0.32.0
  - @btravstack/di@0.32.0

## 0.31.0

### Patch Changes

- Updated dependencies [9ce7852]
  - @btravstack/config@0.31.0
  - @btravstack/core@0.31.0
  - @btravstack/di@0.31.0

## 0.30.1

### Patch Changes

- @btravstack/config@0.30.1
  - @btravstack/core@0.30.1
  - @btravstack/di@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [a590301]
  - @btravstack/core@0.30.0
  - @btravstack/config@0.30.0
  - @btravstack/di@0.30.0

## 0.29.0

### Minor Changes

- b29b9df: `outbox()` takes `concurrency`, which pins `OUTBOX_CONCURRENCY` (default `4`): at most that many tenants hold a claim or a prune — each a pooled connection, a claim inside a transaction across its batch's publishes — at once, and the rest wait their turn in order. Previously every configured tenant could claim at the same moment, so as many busy tenants as the pool has connections (10, `pg`'s default) starved a publisher sharing that pool. A stop answers a tenant still waiting for a slot at once; release waits only for the batches in flight.
- e3d9625: The relay prunes published rows: with `retainMs` (`OUTBOX_RETAIN_MS`) set, each
  tenant's rows published longer ago are deleted after a sweep that did not come
  back full, a thousand at a time — once a minute, and a second apart while
  batches come back full — pinned to the tenant and holding its lock as a claim
  does. Unset, rows are kept as before. `OutboxStore` gains `prune(tenantId,
  olderThanMs, limit)`, measured on the store's own clock, which
  `prismaOutboxStore` and `memoryOutboxStore` implement.

### Patch Changes

- Updated dependencies [1d2ac78]
- Updated dependencies [5bf7ace]
  - @btravstack/config@0.29.0
  - @btravstack/core@0.29.0
  - @btravstack/di@0.29.0

## 0.28.0

### Patch Changes

- @btravstack/config@0.28.0
  - @btravstack/core@0.28.0
  - @btravstack/di@0.28.0

## 0.27.0

### Minor Changes

- dafe570: `prismaOutboxStore` pins each tenant before it reads or marks, transaction-
  locally, so the outbox table may carry `@@rls` like any tenant-owned table and
  the relay may connect as a non-owner, `NOBYPASSRLS` role. The setting defaults
  to `app.tenant_id` (`tenantSetting`), and on a table without row security the
  pin changes nothing. The health check's `oldestPending` now reads each tenant
  pinned, on one connection. `columns` names the physical columns of a model
  mapped with `@map`.

### Patch Changes

- Updated dependencies [bd99464]
  - @btravstack/core@0.27.0
  - @btravstack/config@0.27.0
  - @btravstack/di@0.27.0

## 0.26.0

### Minor Changes

- 0034a32: A variable a starter option can pin is now required in a boot's `env` unless the call pins it, and absent from it when it does: `jwtAuthenticator`, `oidc()`, `sessionAuthenticator`, `sessionCodec` and `outbox` infer their options as written, and their needs say `HTTP_JWT_ISSUER` (and the like) is required when the option is left out, optional when its value may be `undefined`, and not read when it is given. `Unpinned<O, K, V>`, `MaybePinned<O, K, V>` and `OptionsAs<O, T>` are the config helpers that spell it.
- 7c7ce8d: The environment variables a graph reads are in its type. A `Config` field names its variable and whether it must be set; `Config.provider` (and the new `Config.env`) put the names in the provider's needs as `EnvReading<Required, Optional>`; every starter's module type names what it reads. `start`, `runMain` and `@btravstack/testing`'s `boot` type their `env` by it, with the kernel's own variables: a required variable must be present, and a misspelt or unread one is a compile error. `StartEnvironment<typeof Root>` types an environment kept apart from the call. A reader that names nothing — `Env` injected whole, a hand-written `ConfigField<T>` — keeps the environment open, as before. A variable a starter option can pin is optional in the type.

### Patch Changes

- Updated dependencies [0034a32]
- Updated dependencies [7c7ce8d]
  - @btravstack/config@0.26.0
  - @btravstack/core@0.26.0
  - @btravstack/di@0.26.0

## 0.25.0

### Patch Changes

- @btravstack/config@0.25.0
  - @btravstack/core@0.25.0
  - @btravstack/di@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [a247848]
  - @btravstack/di@0.24.0
  - @btravstack/config@0.24.0
  - @btravstack/core@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [4f6c649]
  - @btravstack/di@0.23.0
  - @btravstack/config@0.23.0
  - @btravstack/core@0.23.0

## 0.22.0

### Patch Changes

- @btravstack/config@0.22.0
  - @btravstack/core@0.22.0
  - @btravstack/di@0.22.0

## 0.21.0

### Patch Changes

- @btravstack/config@0.21.0
  - @btravstack/core@0.21.0
  - @btravstack/di@0.21.0

## 0.20.0

### Patch Changes

- a59b346: Run each configured tenant's relay loop independently so a pending claim or publish for one tenant does not block another tenant's due messages. Keep publication serial within each tenant and wait for in-flight work on stop.
- Updated dependencies [94d088d]
  - @btravstack/core@0.20.0
  - @btravstack/config@0.20.0
  - @btravstack/di@0.20.0

## 0.19.0

### Minor Changes

- cc21398: **New package: `@btravstack/outbox`, the transactional outbox relay.** `outbox()` claims each tenant's oldest pending messages, hands them to the application's `OutboxPublisher` in outbox order, marks published what was published, and backs off on a refusal — at-least-once, with a per-tenant claim so N replicas take turns on a tenant while each claiming session lives (subscribers deduplicate on the outbox id) and each tenant's committed facts go out in outbox order; one tenant's back-off slows no other. It contributes an `outbox` health check reporting, in one round trip, a tenant whose oldest pending message is older than `OUTBOX_MAX_LAG_MS`, reports every claim and publish to `Observers`, and sleeps on the kernel's `Clock` so a test can drive it. `@btravstack/outbox/prisma`'s `prismaOutboxStore` is the Prisma 8 store, claiming under a transaction-scoped advisory lock; `memoryOutboxStore` is the in-process one. The transaction that writes a business row and its outbox row stays the application's.

### Patch Changes

- Updated dependencies [8e0461b]
- Updated dependencies [a525ecb]
- Updated dependencies [fb06cd9]
- Updated dependencies [a3ce035]
- Updated dependencies [4244b60]
  - @btravstack/core@0.19.0
  - @btravstack/di@0.19.0
  - @btravstack/config@0.19.0
