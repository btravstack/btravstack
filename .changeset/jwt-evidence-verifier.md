---
"@btravstack/http-server": minor
---

Expose `JwtVerifier` and `jwtVerifier()` on `/jwt` for signed-evidence checks
with an explicit expected audience per call and deployment-owned issuer trust.
Reuse JWT authentication's key cache, signature allowlist and required claim
checks without registering another HTTP authentication scheme. Refused
evidence and unavailable issuer keys have separate typed error channels;
credentials are not recorded in observations.
