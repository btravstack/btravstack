# Order GraphQL gateway

A separate HTTP process running `@btravstack/graphql-server` with a Pothos
schema. Its resolvers call the order API through
[`order-api-client`](../order-api-client) and forward the incoming bearer token.
Set `ORDER_API_URL` to the order API origin; it defaults to
`http://127.0.0.1:3000` for the local loop. The GraphQL listener uses `PORT`
(default `3001` in `pnpm dev`).

The schema source is [`src/graphql-schema.ts`](./src/graphql-schema.ts). Run
`pnpm --filter @btravstack/example-order-graphql-api graphql:schema` to update
the client-facing [`schema.graphql`](../order-graphql-contract/schema.graphql).
