---
"@btravstack/oauth-client": minor
"@btravstack/config": minor
"@btravstack/http-server": patch
---

New package: `@btravstack/oauth-client`, the client credentials half of an
outbound token source. `oauthClient()` provides a `TokenSource` port over an
OAuth 2.0 authorization server — configured from `OAUTH_ISSUER`,
`OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`, discovered lazily, a token kept
per audience and scope until a minute before it expires, one fetch shared by
concurrent callers, every fetch reported to `Observers` and an `oauth-client`
health check. A refusal is a typed `TokenRefused` carrying the issuer's
`error` code, an outage a `TokenIssuerUnavailable`. `staticTokenSource` is
the in-process adapter a spec overrides with.

`@btravstack/config` now exports `cleartext` and `cleartextRefused`, the rule
`oidc()` and `jwtAuthenticator` refuse a cleartext issuer or JWKS by, moved
out of `@btravstack/http-server` so a package that only calls out can apply it.

The rule also refuses any scheme other than `https:` and `http:`, opt-in or not: a `file:` issuer or JWKS URL used to pass boot and fail on first use, and is now a `ConfigInvalid` at boot for `oidc()`, `jwtAuthenticator` and `oauthClient()` alike.
