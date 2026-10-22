---
title: '@btravstack/http-client'
description: Policy-bound outbound HTTPS with application-approved origins, checked DNS destinations and bounded complete responses.
---

# @btravstack/http-client

> **Reference.** A small outbound HTTPS boundary for tenant-configured integrations.
> The application approves network access; tenant settings only choose among it.

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { HttpClient, httpClient, type HttpPolicy } from "@btravstack/http-client";

class IntegrationPolicy extends Port("IntegrationPolicy")<HttpPolicy> {}
const Integrations = Module("Integrations")({
  imports: [httpClient(IntegrationPolicy)],
  provides: [Provider(IntegrationPolicy)({
    inject: {},
    value: {
      origins: ["https://api.example", "https://login.example:8443"],
      maxResponseBytes: 1_048_576,
      deadlineMs: 5_000,
    },
  })],
  exports: [HttpClient],
});
```

The policy port belongs to the application. Deployment-specific limits can come
from an application `Config.provider`; approvals must come from trusted
application/deployment configuration, never tenant input. Construction snapshots
the origins and limits. Invalid origins or non-positive/non-integer limits return
`HttpPolicyInvalid`. Limits cannot exceed `2_147_483_647`.

`HttpClientService.request` takes `url`, optional `method`, `headers`, `body`
(string or Uint8Array), and `signal`. It returns an `AsyncResult` containing a
complete `{ status, headers, body }` response. HTTP statuses other than redirects,
including 304, 401 and 500, remain responses for the protocol caller to interpret.
Headers are lowercase; repeated values are joined with a comma. This client has no cookie jar.
Request headers cannot override Host, framing, connection management or upgrades.
Methods are GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS; other runtime values
are refused before network work, including calls from JavaScript.

Approvals compare normalized exact HTTPS origins, including ports. URL
credentials and unsupported schemes are refused before transmission. A different
subdomain or non-default port requires its own approval. Literal private/reserved
addresses are refused unless covered by the private-origin policy below. Every connection resolves all DNS answers and refuses
the destination if any answer is private/reserved and unapproved; that checked address is the
one used for the connection, with the original TLS hostname and SNI preserved.

No redirects are followed. No proxy is used, including one configured through
proxy environment variables. Each request creates a fresh connection with fresh
DNS and TLS verification; connections and TLS sessions are not reused. There are
no request-supplied agents, resolvers, TLS or proxy settings.

Only identity content encoding is supported. `Accept-Encoding: identity` is sent,
and a server answering another encoding receives `HttpEncodingRefused`. Nothing
is decompressed. `maxResponseBytes` bounds the complete streamed body in bytes,
including chunked responses, independently of Content-Length. A single deadline
covers DNS, TCP connect, TLS, headers and body consumption. Expiry and caller
cancellation destroy the connection. OS DNS work can finish later but cannot
open a socket after the operation has settled.

| Refusal                    | Meaning                                                                       |
| -------------------------- | ----------------------------------------------------------------------------- |
| `HttpPolicyRejected`       | Invalid URL, scheme, credentials, origin, headers or unsupported fetch shape. |
| `HttpDestinationForbidden` | Literal or any DNS answer is private/reserved and unapproved.                 |
| `HttpRedirectRefused`      | A 3xx status other than 304, with no retained Location.                       |
| `HttpEncodingRefused`      | Response is not identity encoded.                                             |
| `HttpResponseTooLarge`     | Streaming bytes exceeded the policy limit.                                    |
| `HttpDeadlineExceeded`     | Whole-operation budget expired.                                               |
| `HttpCancelled`            | Caller aborted.                                                               |
| `HttpUnavailable`          | DNS, TLS, connection or response framing failed.                              |

Refusals retain no request URL, credentials, raw network causes, headers or body.
The DI composition reports only bounded operation names to `Observers`.

## Private origins

`HttpPolicy.privateOrigins` extends the public-only default for specific approved
origins. Each `HttpPrivateOrigin` names an exact origin already present in
`origins` and a non-empty `cidrs` array. Only subnets wholly within RFC 1918
(`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) or IPv6 unique-local
(`fc00::/7`) space are accepted. Use the smallest deployment-owned service range.

```ts
import { createHttpClient, type HttpPrivateOrigin } from "@btravstack/http-client";

const controlPlane: HttpPrivateOrigin = {
  origin: "https://apisix-admin.platform.svc.cluster.local:9444",
  cidrs: ["10.96.0.0/16", "fd00:1234::/32"],
};
const adminClient = createHttpClient({
  origins: [controlPlane.origin],
  privateOrigins: [controlPlane],
  maxResponseBytes: 65_536,
  deadlineMs: 5_000,
});
```

The origin and CIDRs belong to trusted application or deployment configuration,
never tenant input. Construction copies the approvals; changing the policy later
does not broaden an existing client. Duplicate origins, unknown origins, paths,
empty ranges, malformed CIDRs and ranges extending beyond the private allocations
return `HttpPolicyInvalid({ field: "privateOrigins" })` without retaining inputs.

Public destinations remain accepted for an approved origin. Private destinations
must match that origin's own CIDRs, including literal IP origins. Every DNS
answer must pass: mixed allowed/disallowed answers are refused before connecting.
Every new connection repeats the check and connects to the checked answer.
Approvals never admit loopback, link-local metadata services, multicast,
IPv4-mapped IPv6, translation prefixes or other reserved ranges.

Redirects remain refused, including redirects between approved origins. TLS
chain and hostname verification, origin-bound client identities, body limits,
cancellation and the whole-operation deadline apply unchanged. Install the
cluster's trusted CA through Node's normal trust configuration; the policy has
no verification override. The same approvals apply through `httpClient` and
`httpClientFetch`.

## Mutual TLS identities

`HttpPolicy.tlsIdentities` optionally binds an application-owned credential source
to an exact approved origin. Bindings cannot extend `origins`; invalid origins,
paths, duplicate bindings or a missing source return
`HttpPolicyInvalid({ field: "tlsIdentities" })`. A binding is captured when the
client is built. Its credentials are read once for each new connection.

```ts
import { createHttpClient, type HttpTlsIdentity, type HttpTlsBinding } from "@btravstack/http-client";

declare const secretCache: { current: HttpTlsIdentity };
const paymentIdentity: HttpTlsBinding = {
  origin: "https://payments.example",
  credentials: () => secretCache.current,
};
const payments = createHttpClient({
  origins: [paymentIdentity.origin],
  tlsIdentities: [paymentIdentity],
  maxResponseBytes: 65_536,
  deadlineMs: 5_000,
});
```

Inject the source from the application's secret store through the policy
provider, never a request payload. `HttpTlsIdentity` contains PEM `cert` (including
any intermediate chain), PEM `key` and optional `passphrase`. Load secrets
asynchronously into an application-owned cache before use; the source itself is
synchronous and returns one atomic snapshot. To rotate, replace that snapshot
with newly loaded credentials. New connections use the replacement; in-flight
connections retain their original identity. Keep the authorized external account
and its tenant association stable across rotation: those are application data,
not a certificate fingerprint or a TLS policy setting. Request signing and
provider protocol mapping remain the application's responsibility.

Only the matching origin receives the identity. Another approved origin gets no
identity unless explicitly bound; redirects are refused even between approved
origins. Server trust-chain and hostname checks remain mandatory. This surface
exposes no CA, servername, verification callback, agent or TLS options bag.
Empty, malformed, unavailable or throwing credentials return `HttpUnavailable`
without raw causes or secret material in Results or observer diagnostics.
The same policy works through `httpClient(policyPort)` and `httpClientFetch`.

## OAuth composition

`createHttpClient` builds the same boundary without DI. `httpClientFetch` adapts it
to a native fetch consumer such as `oauthClient`'s `fetch` option:

```ts
import { createHttpClient, httpClientFetch } from "@btravstack/http-client";
import { oauthClient } from "@btravstack/oauth-client";

const approved = createHttpClient({
  origins: ["https://login.example", "https://tokens.example"],
  maxResponseBytes: 65_536,
  deadlineMs: 5_000,
});
const oauth = approved.map((client) => oauthClient({
  issuer: "https://login.example",
  fetch: httpClientFetch(client),
}));
```

Discovery and every credential-bearing token request use that same boundary.
A discovery document naming `https://another.example/token` cannot approve that
origin: the application must already have allowed it. A refused discovery or
token request becomes OAuth's `TokenIssuerUnavailable`. The adapter supports
URL/string inputs, the listed methods, Headers, string/URLSearchParams/Uint8Array
bodies, signals and redirect metadata (redirects are always refused). String and
URLSearchParams bodies receive fetch's standard Content-Type when the caller has
not supplied one; Uint8Array bodies receive no inferred type. Other
RequestInit options and Request objects are refused. This is a narrow fetch
adapter, not a replacement for the full browser fetch API.

The existing OAuth default remains suitable for fixed deployment-owned issuers;
compose this boundary before accepting tenant-controlled integration settings.
See [OAuth client](/reference/oauth-client).

## Address policy sources

The conservative prefix policy was checked on 2026-10-17 against IANA's
[IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/),
[IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/),
[IPv6 address space allocation](https://www.iana.org/assignments/ipv6-address-space/)
and [global unicast assignments](https://www.iana.org/assignments/ipv6-unicast-address-assignments/).
By default, all listed IPv4 special-purpose allocations are refused, including their public
anycast exceptions, as are multicast/reserved IPv4. IPv6 accepts only the listed
allocations to regional Internet registries within `2000::/3`, excluding
`2001:db8::/32` and `2620:4f:8000::/48`. Unallocated and reserved global unicast,
`2001::/23` and 6to4 are refused.
IPv4-mapped IPv6, NAT64, multicast and other reserved IPv6 remain refused.
Only the explicit private-origin policy above admits RFC 1918 and unique-local ranges.
This intentionally trades access to special-purpose public services for a small,
auditable application boundary. Network egress controls must also stop a public
address being locally routed to private infrastructure.

Generated API: [@btravstack/http-client](/api/http-client/).
