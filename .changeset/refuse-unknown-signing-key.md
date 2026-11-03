---
"@btravstack/http-server": patch
---

Refuse a JWT whose `kid` and `alg` select no published key (`ERR_JWKS_NO_MATCHING_KEY`,
`ERR_JWKS_MULTIPLE_MATCHING_KEYS`) instead of treating it as an issuer outage.
`jwtVerifier()` now answers `CredentialRefused` rather than `AuthenticatorUnavailable`,
and neither `jwtVerifier()` nor `jwtAuthenticator()` settles an `error` observation for
it, since the token's sender controls its header. `jose` still refetches the key set
once for an unknown `kid`, so a rotation is picked up before the refusal. A key set
that cannot be fetched or parsed remains `AuthenticatorUnavailable` and observed.
