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
the released 0.4.2 fixes with unthrown 5.12.1 and oRPC beta.44. The strict
consumer gate still checks the older advertised floor.

**A body is limited by how the route reads it.** `body-limit.ts` replaces
oRPC's `RequestLimitHandlerPlugin` with one plugin under upstream's name and
order (inside `~batch`, inside `~request-compression`, so a body is measured
inflated). A `resolveBody` call with the hint `"octet-stream"` — what the
OpenAPI codec passes for a route declaring `requestBodyHint: "octet-stream"` —
gets the raw stream bounded by `HttpConfig.streamBodyLimit`
(`HTTP_STREAM_BODY_LIMIT`, 1 GiB); every other call goes through upstream's
own limiting interceptor, run with `bodyLimit`, so buffered bodies keep
oRPC's parsing exactly. The hint is the route's, never inferred from headers,
so a client cannot select the larger limit; the RPC codec never passes one.
A declared `content-length` over the stream limit is refused before reading;
past it, the stream errors with `PAYLOAD_TOO_LARGE` and a handler
interceptor answers `413` whatever the handler made of that error, because
`@unthrown/orpc` turns an `ORPCError` defect cause into a `500` on purpose.
The request carries that state under a symbol key, which survives the spreads
other interceptors make of it. `@orpc/node`'s `TmpFileUploadHandlerPlugin`
has the same three-kind model but spools files to disk and adds a peer; a
route that streams needs neither. The default is finite because nothing is
buffered: the limit bounds one client's hold on a connection and whatever the
handler streams into, not memory.

`HttpModule` shares application-root exports with `GraphqlModule`: runtime
ports are automatic, as are available `Logger` and `HealthChecks` ports.
Business exports remain explicit; private imported providers remain private.

**Controller namespaces are literal API names, never runtime object identity.**
`defineHttp({ namespace: "payments-api" })` keeps the namespace in `Http` and
`ControllerPortOf`, including after `units()`, so di cannot mistake one API's
controller for another. Dynamic strings and union names are refused. Unnamed
APIs retain `OrpcController:<path>`; named ones use
`OrpcController[<namespace>]:<path>`. A namespace cannot contain `]`, so these
identities stay unambiguous even when a resource key contains colons or brackets.
A `Symbol.for` map on `globalThis` caches ports by the complete ID across
bindings and ESM/CommonJS copies; contract object identity is irrelevant.
An automatic UUID was rejected because two UUIDs widen to the same static type,
allowing a graph the compiler accepts but di cannot construct.

Pieces carry their `key` separately from their port ID. Router arrays accept
their own API namespace only, and dependencies are indexed so duplicate paths
cannot disappear in `Object.fromEntries`. Construction checks for duplicate
keys before creating a path-keyed record, reporting a `Defect` through di's
existing `sync` boundary. RPC resource keys and OpenAPI paths stay unchanged.

`ControllerProviderOf` and `ComposedRouterOf` are exported return-type names
so a library consumer can export a controller or composed router and emit
portable declarations. Their handler and dependency calculations stay behind
those names rather than exposing a pnpm-specific peer path.

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
