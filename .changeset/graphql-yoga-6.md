---
"@btravstack/graphql-server": patch
---

Accept `graphql-yoga` 6 beside 5. Refusals are now `graphql`'s own
`GraphQLError`, since Yoga 6 no longer exports `createGraphQLError`, and the
answerer's error masking recognises a `GraphQLError` by name, so a refusal is
still exposed when graphql 17's `development` export condition loads a second
copy of `graphql` beside Yoga's (as Vitest does).
