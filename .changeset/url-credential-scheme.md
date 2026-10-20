---
"@btravstack/http-server": minor
---

**Breaking: `AuthenticatorService` takes the request's query as a second argument.** An authenticator written as `(headers) => …` keeps compiling and behaving as before; code that calls a service directly, such as a scheme's own spec, passes one: `service(headers, new URLSearchParams())`. `resolvePrincipal` takes it as an optional fourth argument.

A scheme can read a signed credential from the request URL, the way a capability URL (`GET /files/42?grant=<payload>.<mac>`) carries one: every scheme is handed `query: URLSearchParams` beside its headers, never the body, parsed once from `request.url` for the oRPC, OpenAPI, htmx, GraphQL and MCP answerers. A grant that is present and refused answers the new `CredentialRefused`, which the walk turns into `403` (as `UnderScoped`, with no scope hint) unless a later requirement accepts the caller; a missing one stays `Unauthenticated` and `401`. The resolved principal seeds the scheme's unit like a token's, so the runtime forks it and closes it once the answer is flushed, a streamed download included. Describe the scheme in `openApiDocument`'s `securitySchemes` as `{ type: "apiKey", in: "query", name: "grant" }`.
