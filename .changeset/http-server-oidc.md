---
"@btravstack/http-server": minor
---

`oidc()` logs a browser in over the authorization-code flow

`oidc({ principal, ... })`, from `@btravstack/http-server/oidc`, is the other
half of the session: `sessionCodec` seals a principal, and this is what
authenticates one. It is an answerer — one `HttpHandler` member beside
`orpc()` and `htmx()` — mounted at `prefix` (default `/auth`) and serving
three routes. `openid-client` is its optional peer, behind that subpath.

`GET <prefix>/login?return=<path>&as=<hint>` seals a PKCE verifier, `state`,
`nonce` and where to return to into a five-minute `__Host-oidc` cookie and
redirects to the provider — `return` being the seam `htmx({ login })` writes,
and `as` riding through as `login_hint`. `GET <prefix>/callback` checks the
returned `state` against that cookie, exchanges the code against the
**registered** redirect URI rather than anything built from `Host`, and seals
`principal(claims)` into `__Host-session`, writing `Session.scopes` from the ID
token's `scope` claim and `Session.sid` from `sid`. `POST <prefix>/logout`
clears the session and sends the browser to the provider's
`end_session_endpoint`, parameterless.

Discovery runs once, at boot: a provider that is not there is a modeled
`OidcUnreachable` naming the issuer, not a `500` on the first login, and the ID
token's signature is checked rather than trusted for having come over TLS.
`return` is decoded exactly once and kept only when it stays on this site.
`issuer`, `clientId`, `clientSecret` and `redirectUri` pin `HTTP_OIDC_ISSUER`,
`HTTP_OIDC_CLIENT_ID`, `HTTP_OIDC_CLIENT_SECRET` and `HTTP_OIDC_REDIRECT_URI`.

Each route is an operation reported to `Observers`: a refusal settles `error`
carrying its own `reason` and clears the spent transient, so a rotated client
secret does not read as a spike of bad logins. It costs a root nothing —
`http()` already contributes the no-op observer, and now exports the port so a
sibling provider can report to the same set.

A `return` path goes through `forLocation` where it becomes a `Location`:
Node's header validator refuses every code point above U+00FF, so `/订单/1`
would otherwise pass the same-site guard and then fail the response with the
authorization code already spent. `forLocation` rather than `encodeURI`,
because the value a browser sent is already percent-encoded and the seam
decodes it exactly once — `encodeURI` would re-encode that `%` and land a real
user on `/orders/a%2520b/row`.

`htmx({ login })` — and `HttpModule({ fragmentsLogin })`, which forwards it —
are the other half of the seam and are new here too: set one and a fragment
route whose `requires` resolves `Unauthenticated` sends the caller to that
login ROUTE carrying `?return=` (a `303` for a navigating browser, a `401`
with `HX-Redirect` for a request htmx made) instead of answering a bare `401`.
An under-scoped caller still gets `403` either way. A consumer has to set one
of them to reach `oidc()` at all.

An `http:` issuer is refused at boot — a `ConfigInvalid` naming
`HTTP_OIDC_ISSUER` — unless its host is loopback (`localhost`, `127.0.0.1`,
`[::1]`) or `allowInsecureIssuer: true` is pinned on `oidc()`. Cleartext sends
the client secret, the authorization code and every token in the open, and the
`allowInsecureRequests` this package applies for such an issuer is the check
that would otherwise have refused it. An option rather than a variable, because
its silent change is a security regression.

`http()` exports `Observers` beside `httpServer()`, so a root that imports the
oRPC sugar and provides `oidc()` discharges the answerer's own need without
writing an observability line.

`SessionCodecService` now publishes `ttlSec`: a login has to write the lifetime
the codec stamps into the cookie's `Max-Age`.

**Breaking:** `sessionAuthenticator`'s `cookie` option is gone, and the name it
defaulted to is exported as `SESSION_COOKIE`. `oidc()` seals that cookie, so a
scheme able to read a different one is a deployment where every login succeeds
into a cookie nothing reads — a redirect loop with no compile error and no
runtime error. Both sides name one constant instead.
