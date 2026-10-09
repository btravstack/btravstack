# @btravstack/orpc-server

## 0.27.0

### Minor Changes

- bd99464: `inject` is optional, absent meaning `{}`, on `OrpcController`, `OrpcRouter`,
  `HtmxGet`, `HtmxPost`, `TemporalWorkflowActivities`, `TemporalActivities`,
  `AmqpHandler` and `AmqpHandlers`. A piece whose every dependency comes off the
  unit declares `unit` alone instead of `inject: {}` beside it.

### Patch Changes

- Updated dependencies [bd99464]
  - @btravstack/htmx-server@0.27.0
  - @btravstack/core@0.27.0
  - @btravstack/http-server@0.27.0
  - @btravstack/config@0.27.0
  - @btravstack/contract@0.27.0
  - @btravstack/di@0.27.0

## 0.26.0

### Minor Changes

- f8c4a76: `HttpModule` takes an `openapi` option — `true`, or `openApiRoutes()`'s options
  — that serves the router as OpenAPI routes beside RPC. The module's `cors` and
  `compression` reach both answerers unless the option's record pins its own, so
  `cors: true` no longer has to be repeated on `openApiRoutes()`. `openapi`
  without a `router` is refused at the call. `openApiRoutes()` stays on the
  `/openapi` subpath for roots built on `http()`.
- 8994a35: `HttpModule` provides the pieces its router and fragments compose. A root that
  keeps its controllers itself lists each once, in `api.OrpcRouter(contract)([…])`,
  instead of again in `provides`; a slice that provides and exports its own piece
  keeps working, since the same provider seen twice is one provider. The composed
  providers carry their pieces on `pieces`, for a root built on `http()`.
- 7c7ce8d: The environment variables a graph reads are in its type. A `Config` field names its variable and whether it must be set; `Config.provider` (and the new `Config.env`) put the names in the provider's needs as `EnvReading<Required, Optional>`; every starter's module type names what it reads. `start`, `runMain` and `@btravstack/testing`'s `boot` type their `env` by it, with the kernel's own variables: a required variable must be present, and a misspelt or unread one is a compile error. `StartEnvironment<typeof Root>` types an environment kept apart from the call. A reader that names nothing — `Env` injected whole, a hand-written `ConfigField<T>` — keeps the environment open, as before. A variable a starter option can pin is optional in the type.

### Patch Changes

- Updated dependencies [8994a35]
- Updated dependencies [0034a32]
- Updated dependencies [7c7ce8d]
  - @btravstack/htmx-server@0.26.0
  - @btravstack/config@0.26.0
  - @btravstack/http-server@0.26.0
  - @btravstack/core@0.26.0
  - @btravstack/contract@0.26.0
  - @btravstack/di@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [c8e1023]
  - @btravstack/http-server@0.25.0
  - @btravstack/htmx-server@0.25.0
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
  - @btravstack/htmx-server@0.24.0
  - @btravstack/http-server@0.24.0
  - @btravstack/contract@0.24.0

## 0.23.0

### Patch Changes

- Updated dependencies [4f6c649]
  - @btravstack/di@0.23.0
  - @btravstack/config@0.23.0
  - @btravstack/core@0.23.0
  - @btravstack/htmx-server@0.23.0
  - @btravstack/http-server@0.23.0
  - @btravstack/contract@0.23.0

## 0.22.0

### Patch Changes

- @btravstack/config@0.22.0
  - @btravstack/contract@0.22.0
  - @btravstack/core@0.22.0
  - @btravstack/di@0.22.0
  - @btravstack/htmx-server@0.22.0
  - @btravstack/http-server@0.22.0

## 0.21.0

### Minor Changes

- 888df26: Split the HTTP runtime from its oRPC, htmx, and GraphQL answerers. Each protocol now has an explicit package and required peers. Add a separate GraphQL gateway that calls the order oRPC API. The GraphQL answerer binds its own typed request units, disables Yoga's wildcard CORS and console logging defaults, and accepts Yoga plugins for schema-specific controls.

### Patch Changes

- Updated dependencies [888df26]
  - @btravstack/http-server@0.21.0
  - @btravstack/htmx-server@0.21.0
  - @btravstack/config@0.21.0
  - @btravstack/contract@0.21.0
  - @btravstack/core@0.21.0
  - @btravstack/di@0.21.0
