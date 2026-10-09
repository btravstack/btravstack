# @btravstack/graphql-server

## 0.27.0

### Minor Changes

- 56157f2: `fieldResult(result)` answers a resolver from an `AsyncResult<T, GraphQLError>`:
  the value, a refusal reported on the field's own path while siblings resolve,
  or a masked defect. A masked defect is now reported to `Observers`, where it
  used to be recorded nowhere. `plugins` accepts a plugin typed by the context it
  reads, checked against the `GraphqlContext` the call builds. `@btravstack/core`
  is a new required peer.

### Patch Changes

- Updated dependencies [bd99464]
  - @btravstack/core@0.27.0
  - @btravstack/http-server@0.27.0
  - @btravstack/contract@0.27.0
  - @btravstack/di@0.27.0

## 0.26.0

### Patch Changes

- Updated dependencies [0034a32]
- Updated dependencies [7c7ce8d]
  - @btravstack/http-server@0.26.0
  - @btravstack/contract@0.26.0
  - @btravstack/di@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [c8e1023]
  - @btravstack/http-server@0.25.0
  - @btravstack/contract@0.25.0
  - @btravstack/di@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [a247848]
  - @btravstack/di@0.24.0
  - @btravstack/http-server@0.24.0
  - @btravstack/contract@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [4f6c649]
  - @btravstack/di@0.23.0
  - @btravstack/http-server@0.23.0
  - @btravstack/contract@0.23.0

## 0.22.0

### Patch Changes

- @btravstack/contract@0.22.0
  - @btravstack/di@0.22.0
  - @btravstack/http-server@0.22.0

## 0.21.0

### Minor Changes

- 888df26: Split the HTTP runtime from its oRPC, htmx, and GraphQL answerers. Each protocol now has an explicit package and required peers. Add a separate GraphQL gateway that calls the order oRPC API. The GraphQL answerer binds its own typed request units, disables Yoga's wildcard CORS and console logging defaults, and accepts Yoga plugins for schema-specific controls.

### Patch Changes

- Updated dependencies [888df26]
  - @btravstack/http-server@0.21.0
  - @btravstack/contract@0.21.0
  - @btravstack/di@0.21.0
