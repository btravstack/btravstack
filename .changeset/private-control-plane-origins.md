---
"@btravstack/http-client": minor
---

Allow deployment-owned private CIDRs for individual approved HTTPS origins through `HttpPolicy.privateOrigins`. The public-only default, connection-time DNS checks, verified TLS, client identities, redirect refusal and bounded operations remain in force. Approvals accept only RFC 1918 and IPv6 unique-local subnets.
