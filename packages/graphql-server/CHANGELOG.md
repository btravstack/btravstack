# @btravstack/graphql-server

## 0.32.0

### Patch Changes

- Updated dependencies [edbd7a3]
  - @btravstack/core@0.32.0
  - @btravstack/http-server@0.32.0
  - @btravstack/config@0.32.0
  - @btravstack/contract@0.32.0
  - @btravstack/di@0.32.0

## 0.31.0

### Minor Changes

- 8a8468f: Add GraphqlModule to compose a GraphQL answerer, its authenticators, and its request modules with the HTTP runtime. GraphqlModule and HttpModule automatically expose the runtime ports and available Logger and HealthChecks infrastructure while keeping business exports explicit.

### Patch Changes

- Updated dependencies [9ce7852]
- Updated dependencies [8a8468f]
  - @btravstack/config@0.31.0
  - @btravstack/http-server@0.31.0
  - @btravstack/core@0.31.0
  - @btravstack/contract@0.31.0
  - @btravstack/di@0.31.0

## 0.30.1

### Patch Changes

- @btravstack/config@0.30.1
  - @btravstack/contract@0.30.1
  - @btravstack/core@0.30.1
  - @btravstack/di@0.30.1
  - @btravstack/http-server@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [a590301]
  - @btravstack/core@0.30.0
  - @btravstack/http-server@0.30.0
  - @btravstack/config@0.30.0
  - @btravstack/contract@0.30.0
  - @btravstack/di@0.30.0

## 0.29.0

### Minor Changes

- a983bf7: `graphql()` takes `maxTokens`, which pins `GRAPHQL_MAX_TOKENS` (default `1000`, `false` for none): a document over it is refused by the parser before any validation rule runs. With the developer tools off, an error's "Did you mean …" suggestions are removed, since they name the schema to a caller who cannot introspect it. A root providing `graphql()` now reads `GRAPHQL_MAX_TOKENS` as well, and an existing deployment whose clients send documents over 1000 tokens must raise it. The `graphql` peer floor rises to `16.6.0`, the first 16.x whose parser enforces `maxTokens`; an older one would ignore the bound silently.

### Patch Changes

- Updated dependencies [1d2ac78]
- Updated dependencies [5bf7ace]
  - @btravstack/config@0.29.0
  - @btravstack/http-server@0.29.0
  - @btravstack/core@0.29.0
  - @btravstack/contract@0.29.0
  - @btravstack/di@0.29.0

## 0.28.0

### Minor Changes

- 7d70401: `graphql()` takes `developerTools`, which pins `GRAPHQL_DEVELOPER_TOOLS` (default `false`) and turns GraphiQL and introspection on together. Introspection, previously always answered, is now off unless a deployment turns it on; off, an operation naming `__schema` or `__type` is refused at validation. The answerer now reads `Env`, so a root providing `graphql()` declares `needs: [Env]`, and `@btravstack/config` is a new required peer.

### Patch Changes

- Updated dependencies [3964fd7]
  - @btravstack/http-server@0.28.0
  - @btravstack/config@0.28.0
  - @btravstack/contract@0.28.0
  - @btravstack/core@0.28.0
  - @btravstack/di@0.28.0

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
