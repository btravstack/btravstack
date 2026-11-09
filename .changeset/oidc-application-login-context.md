---
"@btravstack/http-server": minor
---

Bind validated application login context to the protected OIDC transaction and
pass it to principal admission before creating a session or retaining tokens.
Allow applications to derive explicitly allowlisted provider authorization
parameters while preserving the starter's protocol protections. Existing login
integrations keep their behavior when no login context is configured.
