# packages/mcp-server

Read the root `AGENTS.md` and [`../http-server/AGENTS.md`](../http-server/AGENTS.md)
(its auth half is `AUTH.md`) for shared HTTP and authentication decisions. This
package owns only the MCP answerer. The protocol is
`@modelcontextprotocol/sdk`'s, a required peer: this package writes no
JSON-RPC, no transport and no tool schema handling of its own.

**The SDK's `McpServer` is the surface, not a tool DSL of ours.** `server`
builds it with `registerTool`, `registerPrompt` and `registerResource` as the
SDK documents them, so every capability the SDK grows is available the day it
ships, and nothing here restates its schemas. What `mcp()` adds is what every
answerer under the runtime owes: `resolveScheme` over the shared schemes, the
unit fork, the body limit, and the defect channel.

**One server and one transport per request, stateless, answering JSON.** No
`sessionIdGenerator`, so no session outlives a request and a replica answers
any of them — the deployment model of every other answerer here. JSON rather
than an SSE stream per call, because a call is a request and the runtime's
drain already retires streams: a tool that needs progress notifications or a
long-lived stream is the case that would reopen this. Both are closed on the
response's `'close'`. Every method but POST is a `405` before anything is
built: the SDK answers a GET with a standalone SSE stream whatever
`enableJsonResponse` says, which would hold the request's server and unit open
indefinitely.

**`toolResult` is `fieldResult`'s twin, and carries the observers.** A tool
answers through it so a modeled failure is never thrown by hand: `Ok` is the
answer (text for a string; structured content beside its JSON text when that
JSON is an object, as the specification requires; its JSON text alone
otherwise, an array or a number included), `Err` is a `ToolRefused` whose `text` the tool's
own triage wrote — thesis #3: the package maps nothing — and a defect — or a
value JSON cannot encode or `String` cannot coerce — is reported to
`Observers` and answered with a fixed text. It rides the context
rather than being a free function because reporting needs the observers, and
the SDK catches a thrown tool error into a tool error carrying its message,
which would put a defect's cause in front of the model.

**A refusal is a bare `401` or `403`, before the SDK sees the request.** The
runtime's challenge (`protectedResource()`, `HttpChallenges`) rides the `401`,
which is how an MCP client discovers the authorization server. An
authenticator's defect, or a fork that cannot be built, is the runtime's `500`.

**`HTTP_BODY_LIMIT` is the SDK's `maxRequestBodySize`.** The SDK refuses `0`,
the runtime's "unbounded", so `0` becomes the largest safe integer.

**Two casts, one reason.** The SDK's declarations do not hold under
`exactOptionalPropertyTypes` (its transport's optional handlers against its
own `Transport`), so `server.connect` takes the transport through a cast, in
the source and in the spec's client.

**`McpModule` is `AnswererModule`, the root `GraphqlModule` already was.**
`HttpModule` refuses a root serving neither a router nor fragments, so an
MCP-only deployment needs a root of its own; the one `GraphqlModule` carried
knew nothing about GraphQL, so it moved to `@btravstack/http-server/internal`
as `AnswererModule` and both names are it.

**What the server asks of the client is out of reach, and that is the same
decision.** Sampling, elicitation and roots are requests the server sends the
client, and the SDK checks them against the capabilities the client declared
at `initialize` — on the instance that answered it, which a stateless server
does not keep, and over a stream a JSON answer does not hold open. A tool here
answers from what it was called with. `notifications/cancelled` is out of reach
for the same reason: it arrives as another POST, to another instance that never
saw the call it names. What cancels a call is the client dropping its request,
which aborts the context's `signal`; a tool that runs long reads it. A session
store and an SSE transport are what would reopen both.

**Not included, deliberately:** sessions and resumable streams (the
statelessness above), and DNS-rebinding protection (a guard for servers on a
user's machine, while this one sits behind authentication).
