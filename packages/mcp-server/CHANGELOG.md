# @btravstack/mcp-server

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
