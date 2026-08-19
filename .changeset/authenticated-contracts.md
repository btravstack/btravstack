---
"@btravstack/contract": minor
"@btravstack/http": minor
---

Let a contract declare that a procedure requires an authenticated principal,
and give `@btravstack/http` what it needs to satisfy that declaration.

`@btravstack/contract` is a new zero-dependency package holding the marker
itself: `auth<P>()` mints an `authenticated` combinator for one contract's
principal type, applied to a finished procedure or to a whole record of them.
It returns the node unchanged — the marker lives in a `WeakSet` and a phantom
type key — so a client can import a marked contract without pulling in
anything that implements it. A handler under a marked key reads
`opts.context.principal` typed as `P`, and a controller that ignores it no
longer compiles under that key. An unmarked procedure is public; the marker
makes the requirement legible in the contract rather than detecting one that
was forgotten.

`@btravstack/http` resolves the principal through a new `Authenticator` port —
`HttpAuthenticator<P>()([deps], { sync })`, an ordinary di provider, wired on
`HttpModule`'s `authenticator` option. A contract that marks nothing needs no
authenticator; a marked router whose root provides none is di's existing
`UNSATISFIED DEPENDENCIES` gate, and an authenticator resolving the wrong
principal type is refused at `HttpModule`. A marked procedure whose
authenticator declines is answered `UNAUTHORIZED` before dispatch, with the
handler never running and the `Unauthenticated`'s `reason` left in the process
— it is the application's, to log where it decides.

`http()` and `HttpModule` also gain `plugins`, forwarding oRPC handler plugins
(CORS, body limits, compression, CSRF) straight to `RPCHandler`, and
`securityHeaders`, applied on the node listener rather than as a plugin so the
runtime's own `404` is covered too. `plugins` is an honest escape hatch rather
than a keyhole — an oRPC plugin's `init` can reach the handler's interceptors —
but the ordinary path is configuration visible at the composition root, not a
middleware slot for application logic.
