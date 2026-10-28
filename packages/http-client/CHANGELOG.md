# @btravstack/http-client

## 0.52.0

### Patch Changes

- @btravstack/core@0.52.0
  - @btravstack/di@0.52.0

## 0.51.0

### Patch Changes

- @btravstack/core@0.51.0
  - @btravstack/di@0.51.0

## 0.50.0

### Patch Changes

- @btravstack/core@0.50.0
  - @btravstack/di@0.50.0

## 0.49.0

### Patch Changes

- @btravstack/core@0.49.0
  - @btravstack/di@0.49.0

## 0.48.1

### Patch Changes

- @btravstack/core@0.48.1
  - @btravstack/di@0.48.1

## 0.48.0

### Minor Changes

- b3f21d1: Allow deployment-owned private CIDRs for individual approved HTTPS origins through `HttpPolicy.privateOrigins`. The public-only default, connection-time DNS checks, verified TLS, client identities, redirect refusal and bounded operations remain in force. Approvals accept only RFC 1918 and IPv6 unique-local subnets.

### Patch Changes

- @btravstack/core@0.48.0
  - @btravstack/di@0.48.0

## 0.47.0

### Patch Changes

- @btravstack/core@0.47.0
  - @btravstack/di@0.47.0

## 0.46.0

### Patch Changes

- Updated dependencies [660e817]
  - @btravstack/core@0.46.0
  - @btravstack/di@0.46.0

## 0.45.1

### Patch Changes

- @btravstack/core@0.45.1
  - @btravstack/di@0.45.1

## 0.45.0

### Patch Changes

- @btravstack/core@0.45.0
  - @btravstack/di@0.45.0

## 0.44.1

### Patch Changes

- @btravstack/core@0.44.1
  - @btravstack/di@0.44.1

## 0.44.0

### Patch Changes

- @btravstack/core@0.44.0
  - @btravstack/di@0.44.0

## 0.43.0

### Patch Changes

- @btravstack/core@0.43.0
  - @btravstack/di@0.43.0

## 0.42.0

### Patch Changes

- @btravstack/core@0.42.0
  - @btravstack/di@0.42.0

## 0.41.0

### Patch Changes

- @btravstack/core@0.41.0
  - @btravstack/di@0.41.0

## 0.40.0

### Minor Changes

- c60a7d5: Support application-owned mutual TLS identities bound to exact approved origins. Credential sources allow rotation without changing application account authorization, while retaining mandatory server verification, destination checks, redirect refusal, response limits, deadlines and redacted failures.

### Patch Changes

- @btravstack/core@0.40.0
  - @btravstack/di@0.40.0

## 0.39.1

### Patch Changes

- Updated dependencies [1c3e10b]
  - @btravstack/core@0.39.1
  - @btravstack/di@0.39.1

## 0.39.0

### Minor Changes

- 6117825: Add an application-policy-bound outbound HTTPS client with exact approved origins,
  connection-time destination checks, verified TLS, refused redirects and encoding,
  bounded response bytes, whole-operation deadlines and cancellation. OAuth can use
  the same composed fetch boundary for discovery and credential-bearing token calls.

### Patch Changes

- @btravstack/core@0.39.0
  - @btravstack/di@0.39.0
