---
"@btravstack/orpc-server": minor
---

`HttpModule` takes an `openapi` option — `true`, or `openApiRoutes()`'s options
— that serves the router as OpenAPI routes beside RPC. The module's `cors` and
`compression` reach both answerers unless the option's record pins its own, so
`cors: true` no longer has to be repeated on `openApiRoutes()`. `openapi`
without a `router` is refused at the call. `openApiRoutes()` stays on the
`/openapi` subpath for roots built on `http()`.
