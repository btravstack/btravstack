# @btravstack/temporal-client

## 0.37.0

### Patch Changes

- @btravstack/di@0.37.0

## 0.36.0

### Minor Changes

- 7b844ad: Adopt `@temporal-contract/*` 8.0.0-beta.14: cross-queue `context.executeActivity` from workflows and standalone activities from clients. `TemporalModule`'s `workflows` is optional, so an activity-only contract (a rendering pool's queue) boots a worker with no workflow bundle. `ensureSchedule` no longer answers `WorkflowNotInContractError`, which beta.12 removed: an undeclared name is a defect.

### Patch Changes

- @btravstack/di@0.36.0

## 0.35.1

### Patch Changes

- @btravstack/di@0.35.1

## 0.35.0

### Minor Changes

- 42fe1f1: Install a Temporal `DataConverter` (payload codecs) on both starters. `TemporalModule` takes `dataConverter`, an application-declared port whose `DataConverter` is handed to `Worker.create`; `temporalClient` takes the same port as an optional fourth argument and hands it to `new Client`. One provider, injected where the codec's key store lives, keeps the worker and its clients on one converter.

### Patch Changes

- @btravstack/di@0.35.0

## 0.34.0

### Patch Changes

- @btravstack/di@0.34.0

## 0.33.0

### Patch Changes

- Updated dependencies [f5ae34d]
  - @btravstack/di@0.33.0

## 0.32.0

### Patch Changes

- @btravstack/di@0.32.0

## 0.31.0

### Patch Changes

- @btravstack/di@0.31.0

## 0.30.1

### Patch Changes

- @btravstack/di@0.30.1

## 0.30.0

### Patch Changes

- @btravstack/di@0.30.0

## 0.29.0

### Patch Changes

- @btravstack/di@0.29.0

## 0.28.0

### Patch Changes

- @btravstack/di@0.28.0

## 0.27.0

### Patch Changes

- @btravstack/di@0.27.0

## 0.26.0

### Patch Changes

- @btravstack/di@0.26.0

## 0.25.0

### Patch Changes

- @btravstack/di@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [a247848]
  - @btravstack/di@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [4f6c649]
  - @btravstack/di@0.23.0

## 0.22.0

### Minor Changes

- 03913e6: Add standalone scoped DI providers for typed AMQP and Temporal clients. The
  calling packages depend on the upstream client libraries, without worker
  dependencies.

### Patch Changes

- @btravstack/di@0.22.0
