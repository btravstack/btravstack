---
"@btravstack/http-server": minor
---

`jwtAuthenticator` and `oidc()` take a `variablePrefix` naming the variables an instance reads (`<prefix>_JWKS_URI`, `_ISSUER`, `_AUDIENCE` for a JWT scheme, default `HTTP_JWT`; `<prefix>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI` for a login, default `HTTP_OIDC`), so a second one is configured from the environment like the first. Its `ConfigInvalid` and its cleartext refusal name the instance's own variable.
