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

**A defect is reported to `Observers` before oRPC answers `500`.**
`@unthrown/orpc` rethrows a `Defect`'s cause and oRPC turns it into a bare
`INTERNAL_SERVER_ERROR`, so without a hook the cause was recorded nowhere.
`reportDefects` is a client interceptor on both handlers, not a handler
interceptor: the handler's also sees a body it failed to decode, which it
answers `400`. It reports what oRPC would answer with a 5xx unless the contract
declares the error, because a declared custom code (`INVALID_QUANTITY`) falls
back to `500` with no `errorStatusMap` and is still a refusal. The operation
has the same shape as `graphql-server`'s masked defect. `Observers` comes from
`httpServer()`'s `noObserverMember`, so no root gains wiring.

**The Result bridge supports both `@unthrown/orpc` 0.2 and 0.4.2.** The peer
range retains the older line for existing consumers, while the catalog checks
the released 0.4.2 fixes with unthrown 5.12.1 and oRPC beta.34. The strict
consumer gate still checks the older advertised floor.
