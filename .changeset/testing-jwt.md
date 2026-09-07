---
"@btravstack/testing": minor
---

A new subpath, `@btravstack/testing/jwt`, exporting `localIssuer(options)` — a
generated key pair, a `node:http` listener answering its public key as a JWKS
on any path, and a `sign(claims?, options?)` closing over the private key,
answering `AsyncResult<string, never>` like every other async surface here.
`sign`'s `expiresIn: false` mints a token with no `exp` claim; `localIssuer`'s
`algorithm` picks the asymmetric algorithm (`"RS256" | "RS384" | "RS512" | "ES256" | "ES384"`,
default `"RS256"`) — the same list `@btravstack/http-server`'s `jwtAuthenticator`
accepts. `jose` joins the peers as an **optional** one, behind the subpath:
nothing on the main entry point imports it, so a consumer that never imports
`@btravstack/testing/jwt` installs nothing extra.

It is promoted from `@btravstack/http-server`'s own private test fixture, not
written fresh: the starter's JWT authenticator tests, the example
application's specs and its dev-loop OIDC issuer all want the identical key
pair, listener and signer, which is what makes it a package surface rather
than a starter's private helper.
