---
"@btravstack/http-server": minor
---

Let an OIDC login context derive its redirect URI and post-logout redirect URI
from the validated context and injected services, so one `oidc()` serves an
application whose hosts each register their own redirect URI. Derived URIs are
validated before the provider redirect, bound into the protected transaction,
used for the authorization request and the code exchange, and checked against
the host and path the callback arrives on. Logout returns to the post-logout URI
the session was admitted with. The static redirect URI is not read when the
context derives one; existing integrations keep their behavior.
