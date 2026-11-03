---
"@btravstack/http-server": patch
---

Refuse a JWT whose `kid` and `alg` select no published key (`ERR_JWKS_NO_MATCHING_KEY`,
`ERR_JWKS_MULTIPLE_MATCHING_KEYS`) instead of treating it as an issuer outage.
`jwtVerifier()` now answers `CredentialRefused` rather than `AuthenticatorUnavailable`,
and neither `jwtVerifier()` nor `jwtAuthenticator()` settles an `error` observation for
it, since the token's sender controls its header. A key set that cannot be fetched or
parsed, or that publishes the key the token selects (by `kid`, `kty` and `alg`) with metadata no verification can use
(`key_ops`, `use`, `ext`), remains `AuthenticatorUnavailable` and observed
(`reason: "key_unusable"` for the latter).

`jose` refetches the key set for an unknown `kid` only when its cached copy is older
than its 30-second cooldown. Within that window a token signed with a newly published
key is refused without a fetch, and verifies on a later attempt.
