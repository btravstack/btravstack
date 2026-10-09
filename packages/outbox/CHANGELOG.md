# @btravstack/outbox

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
