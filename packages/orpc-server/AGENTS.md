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
back to `500` without a local status and is still a refusal. The operation
has the same shape as `graphql-server`'s masked defect. `Observers` comes from
`httpServer()`'s `noObserverMember`, so no root gains wiring.

**The Result bridge supports both `@unthrown/orpc` 0.2 and 0.4.2.** The peer
range retains the older line for existing consumers, while the catalog checks
the released 0.4.2 fixes with unthrown 5.12.1 and oRPC beta.34. The strict
consumer gate still checks the older advertised floor.

`HttpModule` shares application-root exports with `GraphqlModule`: runtime
ports are automatic, as are available `Logger` and `HealthChecks` ports.
Business exports remain explicit; private imported providers remain private.

**OpenAPI error statuses belong beside each procedure's error declaration.**
oRPC preserves extra `status` properties in `.errors(...)` entries but its
default codec and generator ignore them. `errorStatusesOf` reads only integer
HTTP error statuses (`400`–`599`). The OpenAPI codec uses the matched
procedure's entry only for an error oRPC recognizes as declared, leaving
validation, access failures and defects on the default mapping. It composes
oRPC's public `StandardHandler` and `NodeHttpHandler`, keeping plugins and
defect reporting on the same hooks as its default OpenAPI handler.

The generator's map is global, whereas domains may reuse a code with different
statuses. `openApiDocument` generates unannotated procedures together, then
each annotated procedure with its own map, passing the accumulated document as
the next generator's base. oRPC owns schema registration and collision handling
on every pass; no response-schema rewriting or global code registry is needed.
Only annotated procedures pay for extra passes. Object and function operation
`spec` overrides keep oRPC's own behavior. The RPC answerer retains its default
map. A declaration needs `data` or `message` alongside `status` to satisfy
oRPC's error-entry type without importing the server into a contract package.
