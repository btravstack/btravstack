---
"@btravstack/http-server": minor
"@btravstack/config": minor
---

`jwtAuthenticator`'s `jwks`, `issuer` and `audience` are now OPTIONAL, and bound
from `HTTP_JWT_JWKS_URI`, `HTTP_JWT_ISSUER` and `HTTP_JWT_AUDIENCE` when they
are not supplied — the option PINS its variable, the shape `http({ port })`
already has against `PORT`. All three vary by deployment and none by code:
staging and production authenticate against different issuers, a JWKS endpoint
moves, and the audience is the deployment's own name. A variable nobody pinned
and nobody set is a `ConfigInvalid` naming it, at startup, with every offending
variable in one message.

The `string | readonly string[]` forms of `issuer` and `audience` are gone: an
environment carries one string, and a second accepted issuer is a second
authenticator. The prefix is `HTTP_JWT_` rather than `HTTP_JWT_<SCHEME>_`,
because two schemes reading the same three variables are one scheme; a genuine
second issuer pins all three explicitly, exactly as a test does.

`HttpAuthenticator<P, Scope>()` gains a `make` arm beside `sync` — the pair di's
`Provider` has, and naming both is refused. `make` answers
`AsyncResult<AuthenticatorService<P, Scope>, E>` and its `E` becomes the
description's, which `Authenticator<P, Scope, N, E>` and the scheme's own di
provider now carry: a scheme whose configuration is wrong fails the BOOT with a
typed error instead of constructing happily and refusing every caller with a
401 that carries no reason. `jwtAuthenticator`'s piece reads `Env`, and
`HttpModule` now carries that for the schemes it composes — a root writes no
`needs` line for one, the same way it never restated the starter's own `Env`.
A scheme owing any other unmet port is still refused at the `HttpModule` call.

`@btravstack/config` gains `Config.url(variable, options?)`, a string field
validated with `URL.canParse` — the value a consumer hands to `new URL`,
checked before it gets there, because a throw inside a provider's `make` is a
`Defect` naming no variable. `HTTP_JWT_JWKS_URI` is bound through it, so a
scheme-less URI is the same `ConfigInvalid` as an unset one.

It also gains `Config.parse(port, schema)(env)`, the
validate-then-`ConfigInvalid` step `Config.provider` performs, lifted so a piece
that is already its own provider can run it — `Config.provider` is now a caller
of it, so there is one home for that step rather than two copies.
