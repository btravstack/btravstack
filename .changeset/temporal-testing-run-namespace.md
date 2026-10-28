---
"@btravstack/temporal-testing": minor
---

Export `temporalNamespace(address, prefix = "spec")`, the namespace registration `temporalEnvironment` uses, with no test context. It registers `<prefix>-<uuid>`, waits until every Temporal service can use it, and resolves to its name, so a Vitest `globalSetup` that starts workers shared across spec files can register one namespace for the run instead of polling `default` on the shared server. A namespace still unusable after a minute, or a server that stops answering its reads, now rejects with an error naming it, the server's last answer as its `cause`; this applies to `temporalEnvironment` too.
