# @btravstack/http-client

Policy-bound outbound HTTPS for application-approved integrations (#565).
The root AGENTS.md applies. Surface: `src/index.ts` and
`docs/reference/http-client.md`.

The application owns the policy, copied at client construction. Requests snapshot
URL, headers and body at the port entry before observation can defer execution. Tenant settings
can select an approved origin; they cannot add one. Origins are WHATWG-normalized
exact origins, including ports, never suffixes, URL paths or wildcard matches.

The transport is `node:https.request`, with `agent: false` and automatic family
selection disabled. Its connection-time lookup resolves ALL answers and refuses
all of them if any is forbidden. The checked answer itself reaches the socket;
there is no preflight followed by another resolution. No connections or TLS
sessions are pooled across operations. Normal TLS certificate verification and
SNI keep the original hostname. Application-owned TLS identities bind a captured credential source to one approved
exact origin. Only PEM cert/key/passphrase reach TLS; sources refresh atomic
secret snapshots per connection. No CA, verification, SNI or cipher override is
exposed. Missing, malformed or throwing credentials fail closed as redacted
`HttpUnavailable`. Account authorization and secret-store refresh remain the
application's; rotation changes credentials, never origin approval or account
identity. Request input has no TLS controls. There is no proxy, agent or DNS override;
proxy environment variables are ignored by this direct built-in transport.

The address rule is deliberately conservative: every IPv4 IANA special-purpose
prefix, multicast and reserved space is refused, including globally reachable
special-purpose anycast allocations. IPv6 must be in an IANA allocation to a regional Internet registry, with
documentation space excluded. Unallocated global unicast, `2001::/23` and 6to4
are refused. IPv4-mapped IPv6 and all translation
prefixes are refused, even when their embedded IPv4 is public. The source
registries and snapshot date live on the reference page. This cannot detect a
network administrator routing public addresses into a private network; network
egress enforcement remains the deployment's second boundary.

3xx responses other than 304 are conservatively refused without retaining Location.
304 is an ordinary bodyless response. The same method allowlist gates the direct
client and fetch edge at runtime. Only identity content encoding is supported. Responses are buffered under an application byte limit,
counted from every streamed chunk regardless of Content-Length, and a single
whole-operation deadline covers DNS, connect, TLS, headers and body. Cancellation
and expiry destroy the request/socket; the OS DNS lookup itself is not cancellable,
but a late result cannot initiate a connection.

`httpClient(policyPort)` provides the fixed HttpClient port and observes requests
with no URL, headers, bodies or causes in its operation. `createHttpClient` builds
the same boundary without DI. The fetch adapter is only the upstream protocol
edge: unsupported shapes reject, concrete Results become rejections, ordinary
HTTP error statuses remain Responses. String and URLSearchParams bodies gain the
standard fetch Content-Type only when the caller supplied none; byte bodies gain
no inferred type. OAuth accepts it through its native fetch seam with no package
dependency in either direction.

Tests use a real local TLS server. Only DNS answers and the final socket address
are controlled in test fixtures: the production lookup validates fixture DNS
answers before a fixture maps the accepted socket to loopback. The certificate
still verifies `api.example`; the CA is supplied only by the test fixture.
The mTLS fixture requires and verifies a client certificate; ordinary HTTPS
fixtures do not request one. Malformed identity lists and non-object bindings
are modeled policy errors for JavaScript consumers too.
No production configuration bypasses the policy. Tests require loopback sockets,
not Docker or public network access.

No retries, proxy support, decompression, cookie jar, streaming response API,
connection pooling or arbitrary fetch/Node options. Add one only for a concrete
integration and preserve every boundary above.

Allowed origins are permissions, not required dependencies; the client contributes
no reachability health probe. Each operation reports its own outcome.
