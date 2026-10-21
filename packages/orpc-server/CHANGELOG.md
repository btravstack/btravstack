# @btravstack/orpc-server

## 0.45.0

### Patch Changes

- @btravstack/config@0.45.0
  - @btravstack/contract@0.45.0
  - @btravstack/core@0.45.0
  - @btravstack/di@0.45.0
  - @btravstack/htmx-server@0.45.0
  - @btravstack/http-server@0.45.0

## 0.44.1

### Patch Changes

- @btravstack/config@0.44.1
  - @btravstack/contract@0.44.1
  - @btravstack/core@0.44.1
  - @btravstack/di@0.44.1
  - @btravstack/htmx-server@0.44.1
  - @btravstack/http-server@0.44.1

## 0.44.0

### Minor Changes

- 61efe53: **Breaking: `orpc()` no longer serves a procedure whose OpenAPI route streams a body.** A procedure declaring `requestBodyHint: "octet-stream"` or `responseBodyHint: "octet-stream"` now answers `404` over `/rpc` before its handler runs, as an unknown procedure does. `openApiRoutes()` keeps serving it, and a streamed request body stays under `streamBodyLimit`. Declare `responseBodyHint: "octet-stream"` on a download route. An RPC answer that still carries a `ReadableStream` (in its objects, arrays, maps or sets), from a download that does not declare the hint, has the stream's cancellation started and answers `500` at once, reported to `Observers` as a defect. A locked stream cannot be cancelled and is reported as a defect of its own. It used to answer `{}`, leaving the stream unread and uncancelled. The typed RPC client still lists these procedures, so call them on their OpenAPI route.

### Patch Changes

- Updated dependencies [5dcf450]
- Updated dependencies [0fcf5fa]
  - @btravstack/http-server@0.44.0
  - @btravstack/htmx-server@0.44.0
  - @btravstack/config@0.44.0
  - @btravstack/contract@0.44.0
  - @btravstack/core@0.44.0
  - @btravstack/di@0.44.0

## 0.43.0

### Minor Changes

- 2e3662b: **Breaking: `HttpConfig` gains a required `streamBodyLimit` field.** A graph that provides `HttpConfig` by hand must add it; one bound by `HttpModule`, `GraphqlModule` or `http()` needs no change. `OrpcOptions.plugins` is now `StandardHandlerPlugin[]` from `@orpc/server/standard`, since oRPC removed adapter plugins in `2.0.0-beta.37`.

  Stream a body a route reads as a stream, under its own limit. An OpenAPI route declaring `openapi({ inputStructure: "detailed", requestBodyHint: "octet-stream" })` gets `input.body` as a `ReadableStream` while the client is still sending, bounded by the new `streamBodyLimit` option (`HTTP_STREAM_BODY_LIMIT`, default 1 GiB; `false` or `0` is unbounded) instead of `bodyLimit`. A declared `content-length` over the limit answers `413` before reading; a body that passes it errors its stream with `PAYLOAD_TOO_LARGE` and the request answers `413`, whatever the handler made of the error. Every other body keeps `bodyLimit` (`HTTP_BODY_LIMIT`) exactly as before, measured after request decompression. The catalog moves to oRPC `2.0.0-beta.44`.

### Patch Changes

- Updated dependencies [2e3662b]
  - @btravstack/http-server@0.43.0
  - @btravstack/htmx-server@0.43.0
  - @btravstack/config@0.43.0
  - @btravstack/contract@0.43.0
  - @btravstack/core@0.43.0
  - @btravstack/di@0.43.0

## 0.42.0

### Patch Changes

- Updated dependencies [b1c37f2]
  - @btravstack/http-server@0.42.0
  - @btravstack/htmx-server@0.42.0
  - @btravstack/config@0.42.0
  - @btravstack/contract@0.42.0
  - @btravstack/core@0.42.0
  - @btravstack/di@0.42.0

## 0.41.0

### Patch Changes

- @btravstack/config@0.41.0
  - @btravstack/contract@0.41.0
  - @btravstack/core@0.41.0
  - @btravstack/di@0.41.0
  - @btravstack/htmx-server@0.41.0
  - @btravstack/http-server@0.41.0

## 0.40.0

### Patch Changes

- @btravstack/config@0.40.0
  - @btravstack/contract@0.40.0
  - @btravstack/core@0.40.0
  - @btravstack/di@0.40.0
  - @btravstack/htmx-server@0.40.0
  - @btravstack/http-server@0.40.0

## 0.39.1

### Patch Changes

- fa7e85d: Add a literal `namespace` option to `defineHttp` so separate APIs can reuse
  resource names without duplicate-port warnings or ambiguous DI types. The same
  namespace and path reuse one port across contract objects and package copies.
  Router construction rejects duplicate controller paths before composing them.
  Existing unnamed controller IDs, RPC keys and public HTTP paths are unchanged.
- Updated dependencies [1c3e10b]
  - @btravstack/core@0.39.1
  - @btravstack/htmx-server@0.39.1
  - @btravstack/http-server@0.39.1
  - @btravstack/config@0.39.1
  - @btravstack/contract@0.39.1
  - @btravstack/di@0.39.1

## 0.39.0

### Patch Changes

- dfe5898: Challenge verified Bearer credentials missing a route scope with `insufficient_scope`, one sufficient scope alternative and matching protected-resource metadata. Preserve application challenges and keep business, cookie and API-key refusals separate. Custom Bearer authenticators opt in with `bearer: true`.
- Updated dependencies [dfe5898]
  - @btravstack/http-server@0.39.0
  - @btravstack/htmx-server@0.39.0
  - @btravstack/config@0.39.0
  - @btravstack/contract@0.39.0
  - @btravstack/core@0.39.0
  - @btravstack/di@0.39.0

## 0.38.0

### Patch Changes

- Updated dependencies [f1eb578]
  - @btravstack/http-server@0.38.0
  - @btravstack/htmx-server@0.38.0
  - @btravstack/config@0.38.0
  - @btravstack/contract@0.38.0
  - @btravstack/core@0.38.0
  - @btravstack/di@0.38.0

## 0.37.0

### Patch Changes

- @btravstack/config@0.37.0
  - @btravstack/contract@0.37.0
  - @btravstack/core@0.37.0
  - @btravstack/di@0.37.0
  - @btravstack/htmx-server@0.37.0
  - @btravstack/http-server@0.37.0

## 0.36.0

### Patch Changes

- @btravstack/config@0.36.0
  - @btravstack/contract@0.36.0
  - @btravstack/core@0.36.0
  - @btravstack/di@0.36.0
  - @btravstack/htmx-server@0.36.0
  - @btravstack/http-server@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies [1c116d0]
  - @btravstack/contract@0.35.1
  - @btravstack/htmx-server@0.35.1
  - @btravstack/http-server@0.35.1
  - @btravstack/config@0.35.1
  - @btravstack/core@0.35.1
  - @btravstack/di@0.35.1

## 0.35.0

### Patch Changes

- @btravstack/config@0.35.0
  - @btravstack/contract@0.35.0
  - @btravstack/core@0.35.0
  - @btravstack/di@0.35.0
  - @btravstack/htmx-server@0.35.0
  - @btravstack/http-server@0.35.0

## 0.34.0

### Patch Changes

- @btravstack/config@0.34.0
  - @btravstack/contract@0.34.0
  - @btravstack/core@0.34.0
  - @btravstack/di@0.34.0
  - @btravstack/htmx-server@0.34.0
  - @btravstack/http-server@0.34.0

## 0.33.0

### Minor Changes

- f5ae34d: Application infrastructure now reaches request and job units with no forwarding. A module's `needs` list is optional: without it, what a module owes is inferred from its providers' `inject` records and its imports, and a root that leaves a port unsupplied is refused at `start`, naming the port. A `needs` list still states and checks an explicit boundary. A unit module reads whatever the application root provides, so the root no longer exports `Logger`, a database client or a configuration port for a unit's sake.

  Two placement rules are now enforced. A unit module that reads `Env` is refused at `start` (`UNIT READS CONFIGURATION — Env is application-scoped`), so configuration is parsed once, at boot. A unit module that provides a port the application scope already provides is refused (at boot for the modules a runtime lists, at the fork otherwise), since each unit would rebuild it; adding a member to one of the application's set ports stays allowed. The migration guide is the new how-to, _Share application infrastructure with units_.

  The bare starters are no longer public. `http` (`@btravstack/orpc-server`), `httpServer` (`@btravstack/http-server`), `amqp` and `temporal` left the packages' entry points, so a deployment root is always `HttpModule`, `GraphqlModule`, `AmqpModule` or `TemporalModule`. Each of those exports its runtime port for `start` to read, so no application writes that export by hand. A root that imported a bare starter becomes the matching module sugar, with the router, handlers or activities passed as its option.

### Patch Changes

- 62f3777: Honor custom HTTP error statuses declared in each procedure's contract error entries on OpenAPI routes and in generated documents. Statuses stay local to the procedure, preserving standard validation and access errors, defect masking, and observation.
- Updated dependencies [f5ae34d]
- Updated dependencies [f690c1c]
  - @btravstack/di@0.33.0
  - @btravstack/core@0.33.0
  - @btravstack/http-server@0.33.0
  - @btravstack/config@0.33.0
  - @btravstack/htmx-server@0.33.0
  - @btravstack/contract@0.33.0

## 0.32.0

### Patch Changes

- Updated dependencies [edbd7a3]
  - @btravstack/core@0.32.0
  - @btravstack/http-server@0.32.0
  - @btravstack/htmx-server@0.32.0
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
  - @btravstack/htmx-server@0.31.0
  - @btravstack/contract@0.31.0
  - @btravstack/di@0.31.0

## 0.30.1

### Patch Changes

- 42305f6: Accept the released `@unthrown/orpc` 0.4.2 bridge while retaining compatibility
  with 0.2 consumers. Validate the workspace against unthrown 5.12.1, the fixed
  oRPC and Pothos bridges, and oRPC 2.0.0-beta.34.
  Use the OpenAPI generator's own base-document parameter type so the newer
  beta's versioned document return type does not break options forwarded to it.
  Preserve origin reflection for enabled CORS and reconcile Result clients
  against the caller's contract when using the released bridge.
- @btravstack/config@0.30.1
  - @btravstack/contract@0.30.1
  - @btravstack/core@0.30.1
  - @btravstack/di@0.30.1
  - @btravstack/htmx-server@0.30.1
  - @btravstack/http-server@0.30.1

## 0.30.0

### Patch Changes

- Updated dependencies [a590301]
  - @btravstack/core@0.30.0
  - @btravstack/htmx-server@0.30.0
  - @btravstack/http-server@0.30.0
  - @btravstack/config@0.30.0
  - @btravstack/contract@0.30.0
  - @btravstack/di@0.30.0

## 0.29.0

### Minor Changes

- 22dc6fc: `orpc()` and the OpenAPI routes report a defect to `Observers` before oRPC answers `500`, as an `orpc` / `defect` operation carrying the cause and the procedure's path. The client still sees only `INTERNAL_SERVER_ERROR`, and an error the contract declares is not reported. Both answerers now read `Observers`, which `httpServer()` already provides, so no root changes.

### Patch Changes

- Updated dependencies [1d2ac78]
- Updated dependencies [5bf7ace]
  - @btravstack/config@0.29.0
  - @btravstack/http-server@0.29.0
  - @btravstack/core@0.29.0
  - @btravstack/htmx-server@0.29.0
  - @btravstack/contract@0.29.0
  - @btravstack/di@0.29.0

## 0.28.0

### Patch Changes

- Updated dependencies [3964fd7]
  - @btravstack/http-server@0.28.0
  - @btravstack/htmx-server@0.28.0
  - @btravstack/config@0.28.0
  - @btravstack/contract@0.28.0
  - @btravstack/core@0.28.0
  - @btravstack/di@0.28.0

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
