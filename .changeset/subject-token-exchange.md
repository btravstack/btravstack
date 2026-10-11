---
"@btravstack/oauth-client": minor
---

Support RFC 8693 token exchange through an optional subject and actor credential on TokenRequest. Cache and single-flight keys isolate every credential and token type with bounded FIFO retention; issuer refusals and outages retain their typed errors. Verify delegation against a real Keycloak issuer.

Health remains keyed by audience and scope, so replacing a refused subject credential restores the component.
