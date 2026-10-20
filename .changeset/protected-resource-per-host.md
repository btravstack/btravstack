---
"@btravstack/http-server": minor
---

Add `protectedResourcePerHost()`: Protected Resource Metadata (RFC 9728) for a deployment serving one domain per tenant. The resource identifier is derived per request from its host and `HTTP_RESOURCE_PATH`, and admitted only when the application's `ServedHosts` port vouches for that host: the metadata document and the `WWW-Authenticate` challenge on the `401` and the typed scope `403` name that host's resource, while an unserved or forged host gets a `404` and no challenge. `HttpChallenges` also takes an `HttpRequestChallenge`, which the runtime settles before dispatch for a request on its path alone.
