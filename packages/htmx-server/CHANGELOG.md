# @btravstack/htmx-server

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
