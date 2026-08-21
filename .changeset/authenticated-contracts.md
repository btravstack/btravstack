---
"@btravstack/contract": minor
"@btravstack/http": minor
---

Let a contract declare that a procedure requires an authenticated caller, and
give `@btravstack/http` what it needs to satisfy that declaration.

**The contract says whether a route is protected; the application's
`httpAuth<Identity>()` says what the principal is.**

`@btravstack/contract` is a new zero-dependency package holding the marker
itself: `authenticated(node)`, one export with no factory and no type
parameter, applied to a finished procedure or to a whole record of them. It
names no identity type at all, so nothing about a server's view of a caller
reaches a client. It returns the node unchanged — the marker lives in a
`WeakSet` and a phantom type key set to `true` — so a client can import a
marked contract without pulling in anything that implements it. `IsMarked<T>`
answers the yes/no at the type level, `isAuthenticated(node)` at runtime. An
unmarked procedure is public; the marker makes the requirement legible in the
contract rather than detecting one that was forgotten.

`@btravstack/http` resolves the principal through a new `Authenticator` port —
`HttpAuthenticator<P>()([deps], { sync })`, an ordinary di provider, wired on
`HttpModule`'s `authenticator` option. A contract that marks nothing needs no
authenticator; a marked router whose root provides none carries the port as an
unmet need `start` refuses, and an authenticator minted on a different
identity than the router is refused at `HttpModule`. A marked procedure whose
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
