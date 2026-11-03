---
"@btravstack/oauth-client": minor
---

Allow `oauthClient({ variablePrefix })` to read an isolated issuer and client credential environment namespace, with matching typed environment requirements. Use a distinct `port` for each client identity; internal discovery/cache state is isolated per source port, and a custom port's health check is named `oauth-client:<port id>`. The defaults remain `OAUTH` and `TokenSource`.
