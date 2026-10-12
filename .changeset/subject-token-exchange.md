---
"@btravstack/oauth-client": minor
---

Support RFC 8693 token exchange through an optional subject and actor credential on TokenRequest. Cache and single-flight keys isolate every credential and token type with bounded FIFO retention; issuer refusals and outages retain their typed errors. Verify delegation against a real Keycloak issuer.

Snapshot the complete request at entry so caller mutation cannot change the grant associated with a credential's cache key. Health remains keyed by audience and scope and follows the newest-started fetch, so replacing a refused subject credential restores the component even when older responses arrive later. Generation bookkeeping is retained only for pending fetches.
