---
"@btravstack/http-server": minor
---

Support RP-initiated OIDC logout with a provider-registered return URI through
`postLogoutRedirectUri` or `<prefix>_POST_LOGOUT_REDIRECT_URI`. Retain the ID-token
hint in protected server-side storage and retrieve it while atomically revoking
credentials, preserving refresh/logout serialization and issuer/client isolation.

Custom `OidcTokensService` implementations must provide the new atomic `logout`
operation. Storage adapters that explicitly serialize token fields must retain
the optional `idToken` field. Existing sessions without that field and deployments
without a return URI keep parameterless provider logout; `postLogout` remains the
fallback when discovery advertises no end-session endpoint.
