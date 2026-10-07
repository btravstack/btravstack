---
title: Serve GraphQL with Yoga and Pothos
description: Mount a code-first GraphQL schema beside oRPC and htmx under one HTTP runtime.
---

# Serve GraphQL with Yoga and Pothos

Install `graphql` and `graphql-yoga` alongside `@btravstack/http-server`. Add
`@pothos/core` when writing the schema in TypeScript. The optional
`@btravstack/http-server/graphql` subpath owns Yoga's Node HTTP integration;
the application supplies a `GraphQLSchema`, so schemas from other builders work
too.

The runnable [order API](https://github.com/btravstack/btravstack/blob/main/examples/order-api/src/graphql-schema.ts) builds
its query and mutation with Pothos. Its [composition root](https://github.com/btravstack/btravstack/blob/main/examples/order-api/src/module.ts)
mounts that schema at `/graphql` beside its existing oRPC and htmx answerers:

<!-- doctest: skip — excerpt of examples/order-api/src/module.ts, compiled by the example's typecheck -->

```ts
import { graphql } from "@btravstack/http-server/graphql";

graphql(api, {
  schema: orderGraphqlSchema,
  requires: [{ user: [] }],
  unit: { find: FindOrder, place: PlaceOrder },
});
```

Put the resulting provider in `HttpModule`'s `provides` array. A standalone
GraphQL process can provide it beside `httpServer()` and export `HttpHandler`
and `HttpRuntime`. Both forms use one listener and the existing longest-prefix
routing. `prefix` changes the mount; its default is `/graphql`.

`requires` protects the **whole mount** before Yoga executes an operation.
Its schemes and scopes use the same `defineHttp` registry, `RequiresGate`, and
principal resolution as the other answerers. Omit it for a public schema.
The resolver context receives `principal`, `unit`, and `signal`. The unit is
forked once per HTTP request, stays open until its response completes, and
participates in the runtime's readiness and drain. Place resource-specific
authorization in a resolver or application service.

The application maps modeled `Result` errors at the resolver boundary. The
example maps `DuplicateOrder` to a `GraphQLError` with `extensions.code` set
to `CONFLICT`; Yoga puts it in the GraphQL `errors` array. GraphQL execution
errors normally retain HTTP 200. Unexpected resolver failures are masked by
Yoga. The framework does not impose HTTP statuses or a GraphQL error schema
on application outcomes.

The Pothos source prints an SDL artifact with
`pnpm --filter @btravstack/example-order-api graphql:schema`. The checked-in
[`order-graphql-contract/schema.graphql`](https://github.com/btravstack/btravstack/blob/main/examples/order-graphql-contract/schema.graphql)
is a separate client-consumable workspace with no HTTP server or Yoga peer.
Its test compares the artifact to the current schema, so a schema edit must
regenerate it before CI. Consumers can feed that SDL to GraphQL codegen and
schema-diff tools without booting the server. Expose a live schema endpoint or
GraphiQL only when the deployment has an audience and access policy for it;
the answerer mounts neither by default.

Subscriptions and GraphQL-over-WebSocket are outside this answerer's scope.
