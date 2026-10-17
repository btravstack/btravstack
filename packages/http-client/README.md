# @btravstack/http-client

Policy-bound outbound HTTPS: application-approved exact origins, connection-time
DNS destination checks, verified TLS, refused redirects, bounded complete bodies,
a whole-operation deadline and caller cancellation, all through `Result`.

Install with `@btravstack/core`, `@btravstack/di` and `unthrown` as peers. Requires
Node >=22 and `moduleResolution: node16` or `nodenext`.

The application provides a policy port to `httpClient(policyPort)`, and injects
`HttpClient`. `createHttpClient(policy)` builds the same capability without DI;
`httpClientFetch(client)` adapts it for `oauthClient({ fetch })` and other native
fetch consumers. Tenant configuration must never supply or expand the policy.

See the [reference](https://btravstack.github.io/btravstack/reference/http-client)
for the compiled composition examples, exact refusal types and address policy.

Direct HTTPS only: no proxies, redirects, connection reuse or decompression.
Only identity responses are accepted, with streaming bytes bounded independently
of Content-Length. No transport override can disable the destination checks.

Tests run real local TLS sockets with controlled DNS/connector fixtures. They
need loopback access, no Docker and no public network.
