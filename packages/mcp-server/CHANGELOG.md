# @btravstack/mcp-server

## 0.48.0

### Minor Changes

- d24f983: Expose immutable HTTP request metadata to request-scoped providers and retain the native request, unit host and cancellation signal in typed oRPC controller contexts. Seed the same metadata for RPC, OpenAPI, htmx, GraphQL and MCP request units.

### Patch Changes

- Updated dependencies [d24f983]
  - @btravstack/http-server@0.48.0
  - @btravstack/contract@0.48.0
  - @btravstack/core@0.48.0
  - @btravstack/di@0.48.0

## 0.47.0

### Patch Changes

- @btravstack/contract@0.47.0
  - @btravstack/core@0.47.0
  - @btravstack/di@0.47.0
  - @btravstack/http-server@0.47.0

## 0.46.0

### Patch Changes

- 4d91402: Model authentication dependency outages as AuthenticatorUnavailable and answer 503 across HTTP answerers. Add openApiDocumentRoute to publish a supplied OpenAPI document at an exact public path.
- Updated dependencies [4d91402]
- Updated dependencies [660e817]
  - @btravstack/http-server@0.46.0
  - @btravstack/core@0.46.0
  - @btravstack/contract@0.46.0
  - @btravstack/di@0.46.0

## 0.45.1

### Patch Changes

- @btravstack/contract@0.45.1
  - @btravstack/core@0.45.1
  - @btravstack/di@0.45.1
  - @btravstack/http-server@0.45.1

## 0.45.0

### Patch Changes

- @btravstack/contract@0.45.0
  - @btravstack/core@0.45.0
  - @btravstack/di@0.45.0
  - @btravstack/http-server@0.45.0

## 0.44.1

### Patch Changes

- @btravstack/contract@0.44.1
  - @btravstack/core@0.44.1
  - @btravstack/di@0.44.1
  - @btravstack/http-server@0.44.1

## 0.44.0

### Patch Changes

- Updated dependencies [5dcf450]
- Updated dependencies [0fcf5fa]
  - @btravstack/http-server@0.44.0
  - @btravstack/contract@0.44.0
  - @btravstack/core@0.44.0
  - @btravstack/di@0.44.0

## 0.43.0

### Patch Changes

- Updated dependencies [2e3662b]
  - @btravstack/http-server@0.43.0
  - @btravstack/contract@0.43.0
  - @btravstack/core@0.43.0
  - @btravstack/di@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [b1c37f2]
  - @btravstack/http-server@0.42.0
  - @btravstack/contract@0.42.0
  - @btravstack/core@0.42.0
  - @btravstack/di@0.42.0

## 0.41.0

### Patch Changes

- @btravstack/contract@0.41.0
  - @btravstack/core@0.41.0
  - @btravstack/di@0.41.0
  - @btravstack/http-server@0.41.0

## 0.40.0

### Patch Changes

- @btravstack/contract@0.40.0
  - @btravstack/core@0.40.0
  - @btravstack/di@0.40.0
  - @btravstack/http-server@0.40.0

## 0.39.1

### Patch Changes

- Updated dependencies [1c3e10b]
  - @btravstack/core@0.39.1
  - @btravstack/http-server@0.39.1
  - @btravstack/contract@0.39.1
  - @btravstack/di@0.39.1

## 0.39.0

### Patch Changes

- dfe5898: Challenge verified Bearer credentials missing a route scope with `insufficient_scope`, one sufficient scope alternative and matching protected-resource metadata. Preserve application challenges and keep business, cookie and API-key refusals separate. Custom Bearer authenticators opt in with `bearer: true`.
- Updated dependencies [dfe5898]
  - @btravstack/http-server@0.39.0
  - @btravstack/contract@0.39.0
  - @btravstack/core@0.39.0
  - @btravstack/di@0.39.0

## 0.38.0

### Minor Changes

- b2b4d89: New package: `@btravstack/mcp-server`, a Model Context Protocol answerer over the official SDK. `mcp(auth, { server, requires?, units?, unit?, prefix? })` serves the `McpServer` your `server` function builds, per request, over a stateless Streamable HTTP transport answering JSON, under `/mcp` by default. It authenticates through the shared `defineAuth()` schemes (a bare `401` or `403`, so `protectedResource()`'s challenge rides the `401`), forks the request's unit, bounds the body by `HTTP_BODY_LIMIT`, and hands `server` the principal, the unit and `toolResult`, which answers a tool from a `Result`: `Ok` as text or structured content, `Err`, a `ToolRefused`, as a tool error carrying its `text`, a defect as a generic tool error reported to `Observers`. `McpModule` is its deployment root: the module `GraphqlModule` was, moved to `@btravstack/http-server/internal` as `AnswererModule` since nothing in it was GraphQL's, so both names are now that one root.

### Patch Changes

- Updated dependencies [f1eb578]
  - @btravstack/http-server@0.38.0
  - @btravstack/contract@0.38.0
  - @btravstack/core@0.38.0
  - @btravstack/di@0.38.0
