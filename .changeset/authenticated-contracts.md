---
"@btravstack/contract": minor
"@btravstack/http-server": minor
---

Let a contract declare that a procedure requires an authenticated caller, and
give `@btravstack/http-server` what it needs to satisfy that declaration.

**The contract says which schemes protect a route; the application says what
each one resolves to.**

`@btravstack/contract` is a new zero-dependency package holding the marker
itself, applied to a finished procedure or to a whole record of them. It
names no identity type at all, so nothing about a server's view of a caller
reaches a client. It returns the node unchanged — the marker lives in a
`WeakMap` off `globalThis` and a phantom type key — so a client can import a
marked contract without pulling in anything that implements it. `IsMarked<T>`
answers the yes/no at the type level, `isAuthenticated(node)` reads the
requirements back at runtime. An
unmarked procedure is public; the marker makes the requirement legible in the
contract rather than detecting one that was forgotten. Its full shape — the
curried `authenticated(...requirements)(node)`, scopes and per-procedure
overrides — is in the _named security schemes_ entry.

`@btravstack/http-server` resolves the principal before dispatch, through an
authenticator per scheme. A contract that marks nothing needs none; a marked
router whose graph provides none carries that scheme's port as an
unmet need `start` refuses. A marked procedure whose
authenticator declines is answered `UNAUTHORIZED` before dispatch, with the
handler never running and no reason reaching the caller — `Unauthenticated`
carries none, so an authenticator logs why before returning.

`http()` and `HttpModule` also gain `plugins`, forwarding oRPC handler plugins
(CORS, body limits, compression, CSRF) straight to `RPCHandler`, and
`securityHeaders`, applied on the node listener rather than as a plugin so the
runtime's own `404` is covered too. `plugins` is an honest escape hatch rather
than a keyhole — an oRPC plugin's `init` can reach the handler's interceptors —
but the ordinary path is configuration visible at the composition root, not a
middleware slot for application logic.
