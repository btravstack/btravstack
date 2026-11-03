---
"@btravstack/http-server": minor
---

Expose `JwtVerifier` and `jwtVerifier()` on `/jwt` for signed-evidence checks
with an explicit expected audience per call and deployment-owned issuer trust.
Reuse JWT authentication's verification implementation (key-set caching,
signature allowlist and required claim checks) without registering another HTTP
authentication scheme; each verifier caches its own issuer's keys. Refused
evidence and unavailable issuer keys have separate typed error channels;
credentials are not recorded in observations.
