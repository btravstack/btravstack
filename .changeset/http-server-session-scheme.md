---
"@btravstack/http-server": minor
---

`sessionAuthenticator` makes the session cookie a scheme

`sessionAuthenticator<P>()({ cookie?, scopes?, principal? })`, from
`@btravstack/http-server/session`, is a third shipped scheme beside
`jwtAuthenticator` and `apiKeyAuthenticator`: bind it in
`defineHttp({ authenticators })` and `requires: [{ session: [] }]` on a
fragment route or `authenticated({ session: [] })` on a procedure work with
nothing new.

It injects `SessionCodec` rather than holding keys, so a root composing it
without `sessionCodec()` is refused at the `HttpModule` call and the codec that
reads a cookie is the one that sealed it. The cookie defaults to
`__Host-session` — a prefix the browser enforces — and is matched by name
exactly. `scopes` is the vocabulary, decided once at composition, and the grant
is its intersection with the session's own; `Session` carries `scopes` for it.
No cookie, a cookie no key opens, an expired session and a principal the
application declines are one `Unauthenticated`.
