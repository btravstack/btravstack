---
"@btravstack/http-server": minor
---

Add opt-in server-side OIDC token retention for delegated API calls. A shared
application-supplied store serializes refresh rotation and logout across replicas;
session cookies carry only an opaque reference alongside the principal. Expose the
same capability to framework adapters without an HTTP listener.
