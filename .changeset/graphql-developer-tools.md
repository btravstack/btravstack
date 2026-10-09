---
"@btravstack/graphql-server": minor
---

`graphql()` takes `developerTools`, which pins `GRAPHQL_DEVELOPER_TOOLS` (default `false`) and turns GraphiQL and introspection on together. Introspection, previously always answered, is now off unless a deployment turns it on; off, an operation naming `__schema` or `__type` is refused at validation. The answerer now reads `Env`, so a root providing `graphql()` declares `needs: [Env]`, and `@btravstack/config` is a new required peer.
