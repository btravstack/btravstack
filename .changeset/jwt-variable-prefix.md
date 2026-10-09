---
"@btravstack/http-server": minor
---

`jwtAuthenticator`'s `variablePrefix` names the three variables a scheme reads (`<prefix>_JWKS_URI`, `_ISSUER`, `_AUDIENCE`, default `HTTP_JWT`), so a second JWT scheme trusting another issuer is configured from the environment like the first. The `ConfigInvalid` and the cleartext-JWKS refusal name the scheme's own variable.
