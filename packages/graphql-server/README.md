# @btravstack/graphql-server

A GraphQL Yoga answerer for the protocol-neutral
[`@btravstack/http-server`](../http-server) runtime. Supply any
`GraphQLSchema`; the package has required GraphQL and Yoga peers and no oRPC
server dependency. `graphql(defineAuth(), { schema })` contributes a
`HttpHandler` member. A request-scoped unit and the Node incoming request are
available to resolvers.
Pass `units` with `unit` to check each injected port against the module the
selected request kind actually forks. Pass the same `units` record to
`httpServer({ unit: units })` so the runtime can apply unit test overrides.
Yoga plugins and CORS policy are explicit
options; the wildcard CORS default and Yoga console logging are disabled.
Preflights use Yoga's CORS policy before authentication, and Yoga plugins are
disposed when the application stops.

See [Serve GraphQL](https://btravstack.github.io/btravstack/how-to/serve-graphql)
and the [separate GraphQL gateway](../../examples/order-graphql-api).
