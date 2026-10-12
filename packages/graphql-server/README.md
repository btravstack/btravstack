# @btravstack/graphql-server

A GraphQL Yoga answerer for the protocol-neutral
[`@btravstack/http-server`](../http-server) runtime. Supply any
`GraphQLSchema`; the package has required GraphQL and Yoga peers and no oRPC
server dependency. `graphql(defineAuth(), { schema })` contributes a
`HttpHandler` member. A request-scoped unit and the Node incoming request are
available to resolvers.
Use `GraphqlModule` for a deployment root:

```ts
import { GraphqlModule, graphql } from "@btravstack/graphql-server";
import { defineAuth } from "@btravstack/http-server";
import { createSchema } from "graphql-yoga";

const schema = createSchema({
  typeDefs: "type Query { hello: String! }",
  resolvers: { Query: { hello: () => "world" } },
});

export const GatewayApi = GraphqlModule("GatewayApi")({
  answerer: graphql(defineAuth(), { schema }),
});
```

The module composes the listener, authenticators and declared request modules.
It exports the runtime ports and available `Logger` / `HealthChecks` without
exposing business ports automatically. Its socket options are the HTTP
runtime's, excluding `cors` and `compression`. Set CORS on `graphql()`; the
answerer does not apply HTTP compression. Schema, authentication and Yoga
options stay on `graphql()`.

Pass `units` with `unit` to check each injected port against the module the
selected request kind actually forks. `GraphqlModule` binds that record to
the runtime automatically; a manually composed root passes the same `units`
record to `httpServer({ unit: units })`.
Yoga plugins and CORS policy are explicit
options; the wildcard CORS default and Yoga console logging are disabled, and
a masked defect is reported to `Observers` instead. GraphiQL,
introspection and "Did you mean …" suggestions stay off unless
`GRAPHQL_DEVELOPER_TOOLS=true` (or `developerTools: true`) turns them on. A
document over `GRAPHQL_MAX_TOKENS` (default `1000`, pinned by `maxTokens`) is
refused by the parser, before validation. `fieldResult(result)`
answers a resolver from an `AsyncResult`, with a refusal on its own field's
path.
Preflights use Yoga's CORS policy before authentication, and Yoga plugins are
disposed when the application stops.

See [Serve GraphQL](https://btravstack.github.io/btravstack/how-to/serve-graphql)
and the [separate GraphQL gateway](../../examples/order-graphql-api).
