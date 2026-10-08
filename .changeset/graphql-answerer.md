---
"@btravstack/http-server": minor
"@btravstack/orpc-server": minor
"@btravstack/htmx-server": minor
"@btravstack/graphql-server": minor
---

Split the HTTP runtime from its oRPC, htmx, and GraphQL answerers. Each protocol now has an explicit package and required peers. Add a separate GraphQL gateway that calls the order oRPC API. The GraphQL answerer binds its own typed request units, disables Yoga's wildcard CORS and console logging defaults, and accepts Yoga plugins for schema-specific controls.
