---
"@btravstack/http-server": minor
---

Add `protectedResource()`, which makes an API an OAuth 2.0 protected resource a client without a token can discover (RFC 9728): it serves the metadata document under `/.well-known/oauth-protected-resource<path>` from `HTTP_RESOURCE_URI` and `HTTP_RESOURCE_AUTHORIZATION_SERVERS`, and a `401` for the resource's own URL carries `WWW-Authenticate: Bearer resource_metadata="…"` through the new `HttpChallenges` set port. A cleartext resource or authorization server is refused at boot unless `allowInsecure` is pinned.
