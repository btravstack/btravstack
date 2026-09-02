---
"@btravstack/http-server": minor
---

Two authenticators ship, so an application stops writing them by hand — the one
area of this framework where "the application writes it" carries a security cost
rather than a keystroke cost.

`apiKeyAuthenticator<P>()({ keys })`, on the main entry point: a constant-time
compare over SHA-256 digests, every configured key checked with no early return,
and a missing header on the same path as a wrong one.

`jwtAuthenticator<P>()({ jwks, issuer, audience, principal, scopes? })`, from
`@btravstack/http-server/jwt` with `jose` as an optional peer: JWKS fetch, cache
and rotation; an asymmetric-only algorithm allowlist, because a JWKS publishes
public keys and accepting `HS256` beside them is the algorithm-confusion attack;
`iss`, `aud` and `exp` required to be present — jose validates `exp` only when
it is, so without that a signed token omitting it authenticates and never
expires — with `nbf` honoured when present and clock tolerance defaulting to
zero. Each scheme's scope vocabulary is inferred from what it grants, so it
cannot name a scope nothing issues. Every failure is the same refusal, so the endpoint is not an oracle.

Both are ordinary `Authenticator` values bound by name in
`defineHttp({ authenticators })`, and a grant goes through the existing scope
walk — no new checking surface. Password hashing and credential issuing are
explicitly out of scope: both of these are on the verifying side.
