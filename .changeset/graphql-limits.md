---
"@btravstack/graphql-server": minor
---

`graphql()` takes `maxTokens`, which pins `GRAPHQL_MAX_TOKENS` (default `1000`, `false` for none): a document over it is refused by the parser before any validation rule runs. With the developer tools off, an error's "Did you mean …" suggestions are removed, since they name the schema to a caller who cannot introspect it. A root providing `graphql()` now reads `GRAPHQL_MAX_TOKENS` as well, and an existing deployment whose clients send documents over 1000 tokens must raise it.
