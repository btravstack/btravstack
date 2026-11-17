# @btravstack/amqp-client

## 0.61.0

### Minor Changes

- bad02b1: **Breaking:** `amqpClient(port, contract, options?)` now returns a `Module`
  that peers on `@btravstack/core` and `@btravstack/config`, instead of a bare
  provider over an application settings port. It reads `AMQP_URL` (default
  `amqp://127.0.0.1:5672`) and `AMQP_CONNECT_TIMEOUT_MS` (default `5000`), the
  worker starter's variables, each pinned by the `url` and `connectTimeoutMs`
  options. Its error channel is `ConfigInvalid | ConnectionError`. It contributes
  an `amqp-client:<port id>` health check that fails while the client is not
  connected, and reports the client library's warnings and errors, such as a
  failed connection attempt, to `Observers`.

  Migration: install the two new peers, drop the settings port, and move the
  call from `provides` to `imports`.

  ```ts
  // Before
  Module("Publisher")({
    provides: [amqpClient(OrderClient, orderContract, AmqpConfig), orderPublisher],
  });

  // After
  Module("Publisher")({
    imports: [amqpClient(OrderClient, orderContract)],
    provides: [orderPublisher],
  });
  ```

  A settings port that did not read those variables becomes options:
  `amqpClient(OrderClient, orderContract, { url, connectTimeoutMs })`.

### Patch Changes

- 117b4cd: Bound start-up against a broker that accepts TCP but never answers the AMQP
  handshake. The `@amqp-contract/client` and `@amqp-contract/worker` peers now
  start at `^3.0.1`, the release that fixes it upstream, and their `unthrown`
  peer at `^5.12.2`, the floor that release's dependencies require: start-up fails within
  `connectTimeoutMs` (`AMQP_CONNECT_TIMEOUT_MS`) with a `ConnectionError` that
  reads `connect ETIMEDOUT`, instead of never settling. A caller's own
  `connectionOptions.connectionOptions.timeout` is kept.
- @btravstack/config@0.61.0
  - @btravstack/core@0.61.0
  - @btravstack/di@0.61.0

## 0.60.0

### Patch Changes

- @btravstack/di@0.60.0

## 0.59.0

### Patch Changes

- @btravstack/di@0.59.0

## 0.58.0

### Patch Changes

- @btravstack/di@0.58.0

## 0.57.0

### Patch Changes

- @btravstack/di@0.57.0

## 0.56.1

### Patch Changes

- @btravstack/di@0.56.1

## 0.56.0

### Patch Changes

- @btravstack/di@0.56.0

## 0.55.1

### Patch Changes

- @btravstack/di@0.55.1

## 0.55.0

### Patch Changes

- @btravstack/di@0.55.0

## 0.54.0

### Patch Changes

- @btravstack/di@0.54.0

## 0.53.0

### Patch Changes

- @btravstack/di@0.53.0

## 0.52.0

### Patch Changes

- @btravstack/di@0.52.0

## 0.51.0

### Patch Changes

- @btravstack/di@0.51.0

## 0.50.0

### Patch Changes

- @btravstack/di@0.50.0

## 0.49.0

### Patch Changes

- 763a861: Allow a validated runtime task queue through TEMPORAL_TASK_QUEUE or a taskQueue pin without changing logical activity-provider identities.

  Infer AMQP deployment contracts from their supplied topology while retaining schema-checked logical handler providers.

  Require the released AMQP beta.12 and Temporal beta.15 trains and exercise their public runtime binding APIs.

- @btravstack/di@0.49.0

## 0.48.1

### Patch Changes

- @btravstack/di@0.48.1

## 0.48.0

### Patch Changes

- @btravstack/di@0.48.0

## 0.47.0

### Patch Changes

- @btravstack/di@0.47.0

## 0.46.0

### Patch Changes

- @btravstack/di@0.46.0

## 0.45.1

### Patch Changes

- @btravstack/di@0.45.1

## 0.45.0

### Patch Changes

- @btravstack/di@0.45.0

## 0.44.1

### Patch Changes

- @btravstack/di@0.44.1

## 0.44.0

### Patch Changes

- @btravstack/di@0.44.0

## 0.43.0

### Patch Changes

- @btravstack/di@0.43.0

## 0.42.0

### Patch Changes

- @btravstack/di@0.42.0

## 0.41.0

### Patch Changes

- @btravstack/di@0.41.0

## 0.40.0

### Patch Changes

- @btravstack/di@0.40.0

## 0.39.1

### Patch Changes

- @btravstack/di@0.39.1

## 0.39.0

### Patch Changes

- @btravstack/di@0.39.0

## 0.38.0

### Patch Changes

- @btravstack/di@0.38.0

## 0.37.0

### Patch Changes

- @btravstack/di@0.37.0

## 0.36.0

### Patch Changes

- @btravstack/di@0.36.0

## 0.35.1

### Patch Changes

- @btravstack/di@0.35.1

## 0.35.0

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
