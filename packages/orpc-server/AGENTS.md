# packages/orpc-server

Read the root `AGENTS.md` and [`../http-server/AGENTS.md`](../http-server/AGENTS.md)
for the HTTP family's decisions. This package owns `defineHttp`, the oRPC
answerer, `HttpModule` and OpenAPI routes. Its peers are required; it has no
GraphQL dependency. `HttpModule` still composes htmx fragments for the order
API, so the htmx peer is explicit. The published `openapi` subpath emits and
serves the application's contract; it does not publish a document by default.
`HttpModule`'s `openapi` option composes the same OpenAPI answerer, and only
beside a `router`, which is why `@orpc/openapi` is a required peer; the
reasoning is in the HTTP family's `AGENTS.md`.
