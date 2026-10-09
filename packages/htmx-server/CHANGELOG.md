# @btravstack/htmx-server

## 0.26.0

### Minor Changes

- 8994a35: `HttpModule` provides the pieces its router and fragments compose. A root that
  keeps its controllers itself lists each once, in `api.OrpcRouter(contract)([…])`,
  instead of again in `provides`; a slice that provides and exports its own piece
  keeps working, since the same provider seen twice is one provider. The composed
  providers carry their pieces on `pieces`, for a root built on `http()`.

### Patch Changes

- Updated dependencies [0034a32]
- Updated dependencies [7c7ce8d]
  - @btravstack/config@0.26.0
  - @btravstack/http-server@0.26.0
  - @btravstack/core@0.26.0
  - @btravstack/contract@0.26.0
  - @btravstack/di@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [c8e1023]
  - @btravstack/http-server@0.25.0
  - @btravstack/config@0.25.0
  - @btravstack/contract@0.25.0
  - @btravstack/core@0.25.0
  - @btravstack/di@0.25.0

## 0.24.0

### Patch Changes

- Updated dependencies [a247848]
  - @btravstack/di@0.24.0
  - @btravstack/config@0.24.0
  - @btravstack/core@0.24.0
  - @btravstack/http-server@0.24.0
  - @btravstack/contract@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [4f6c649]
  - @btravstack/di@0.23.0
  - @btravstack/config@0.23.0
  - @btravstack/core@0.23.0
  - @btravstack/http-server@0.23.0
  - @btravstack/contract@0.23.0

## 0.22.0

### Patch Changes

- @btravstack/config@0.22.0
  - @btravstack/contract@0.22.0
  - @btravstack/core@0.22.0
  - @btravstack/di@0.22.0
  - @btravstack/http-server@0.22.0

## 0.21.0

### Minor Changes

- 888df26: Split the HTTP runtime from its oRPC, htmx, and GraphQL answerers. Each protocol now has an explicit package and required peers. Add a separate GraphQL gateway that calls the order oRPC API. The GraphQL answerer binds its own typed request units, disables Yoga's wildcard CORS and console logging defaults, and accepts Yoga plugins for schema-specific controls.

### Patch Changes

- Updated dependencies [888df26]
  - @btravstack/http-server@0.21.0
  - @btravstack/config@0.21.0
  - @btravstack/contract@0.21.0
  - @btravstack/core@0.21.0
  - @btravstack/di@0.21.0
