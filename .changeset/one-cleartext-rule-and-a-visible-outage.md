---
"@btravstack/http-server": minor
---

Closed four ways the HTTP auth and contract surfaces reported something they
were not.

**A cleartext JWKS endpoint is refused at boot.** `jwtAuthenticator` handed an
`http:` `HTTP_JWT_JWKS_URI` straight to `jose`, while `oidc()` had refused a
cleartext issuer since it shipped — the same class of value, two answers, and
the silent one was the sharper hole: a key set carries public keys, so anything
on the path substitutes its own signing key and mints tokens this process
accepts, with no secret to steal first (RFC 8725 §3). One rule now serves both,
with the same loopback exception (`localhost`, `127.0.0.1`, `[::1]`) and the
same opt-out posture. `allowInsecureJwks: true` is the new option, `oidc()`'s
`allowInsecureIssuer` under another name.

**A JWKS or issuer outage is reported rather than swallowed.** Every
`jwtVerify` rejection became a bodyless `401` with nothing recorded, so a
key-rotation incident presented as every client in the world suddenly sending
bad credentials. A refusal the TOKEN caused is still silent — the endpoint must
not be an oracle for which part an attacker got wrong — but one the issuer's
key set caused now settles an `Observers` operation (`component: "jwt"`,
`name: "verify"`, `outcome: "error"`) with a bounded `reason` and the library's
own cause. The status is unchanged: there is genuinely nothing that can
authenticate anyone, and a `503` would mean putting a transport's status in a
seam that names no protocol.

**`openApiDocument` keeps the `security` of a procedure that renamed itself.**
The fold keyed on the contract path while `@orpc/openapi` writes
`meta?.operationId ?? path.join(".")`, so a procedure with an `operationId` of
its own published with no `security` at all — which a reader takes as public.
The walk now computes the id through the generator's own accessor, so the two
agree by construction.

**`oidc()` contributes its own `CookieSchemes` member, and is therefore
spread**: `...oidc({ principal })`. It reads `__Host-oidc`, seals
`__Host-session` and serves a state-changing `POST <prefix>/logout`, and
contributed nothing — so a root composing it and `sessionCodec()` without
`sessionAuthenticator` ran with CSRF off. The rule to carry forward is that
whatever reads or writes a cookie contributes, whether or not it is an
authenticator.
