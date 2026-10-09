---
"@btravstack/http-server": minor
---

`jwtAuthenticator` and `oidc()` take a `variablePrefix` naming the variables an instance reads (`<prefix>_JWKS_URI`, `_ISSUER`, `_AUDIENCE` for a JWT scheme, default `HTTP_JWT`; `<prefix>_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, `_REDIRECT_URI` for a login, default `HTTP_OIDC`), so a second one is configured from the environment like the first. Its `ConfigInvalid` and its cleartext refusal name the instance's own variable.

`oidc()` now seals the issuer it is configured with into the session, and `sessionAuthenticator` accepts only sessions from its own issuer — read from `HTTP_OIDC_ISSUER`, or `<variablePrefix>_ISSUER`, or pinned with `issuer` — so one login's session is never read by another login's scheme. The scheme now needs `Env` and fails startup with `ConfigInvalid` when that variable is unset. Sessions sealed before the upgrade carry no issuer and are refused: browsers sign in once more.
