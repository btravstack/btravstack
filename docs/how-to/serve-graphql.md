---
title: Serve GraphQL with Yoga and Pothos
description: Run a code-first GraphQL gateway as a separate HTTP process backed by a typed oRPC client.
---

# Serve GraphQL with Yoga and Pothos

> **How-to.** Build a GraphQL schema in TypeScript, run it in its own HTTP
> process, and call a backend through a typed client.

Install `@btravstack/http-server`, `@btravstack/graphql-server`, `graphql`, and
`graphql-yoga`. Add `@pothos/core` when building the schema in TypeScript.
`@btravstack/graphql-server` accepts any `GraphQLSchema`; Pothos is the choice
of this example, not a framework requirement.

The [GraphQL gateway](https://github.com/btravstack/btravstack/blob/main/examples/order-graphql-api/src/module.ts)
boots its own `HttpRuntime` and mounts the schema at `/graphql`. Its
[resolvers](https://github.com/btravstack/btravstack/blob/main/examples/order-graphql-api/src/graphql-schema.ts)
call the order API through a
[typed oRPC client](https://github.com/btravstack/btravstack/blob/main/examples/order-api-client/src/index.ts).
The gateway and order API are separate processes. The gateway needs the HTTP
runtime and GraphQL packages; it does not install the oRPC server.

`graphql(defineAuth(), { schema })` makes the mount public. Pass `requires` to
authenticate the whole mount through the shared HTTP auth registry, and pass
`unit` to inject request-scoped services into resolvers. Declare the selected
unit modules with `units: { anonymous: RequestModule }` in the same
`graphql()` call, and pass that same record to `httpServer({ unit: units })` so
the runtime can report its units and apply test overrides. The compiler then
refuses a port that module does not export. In a
manual composition, include `...answerer.authenticators` in `provides` when
the mount has `requires`. The resolver context
receives `principal`, `unit`, `signal`, and the Node `incoming` request. The
example forwards its bearer header to the backend, which enforces the order
contract's authentication and authorization.

A resolver answers through `fieldResult(result)`: it folds the backend's
modeled errors into `GraphQLError`s with an `extensions.code` — an exhaustive
`mapErrCases`, and `recoverErrCases` where a refusal is `null` — and
`fieldResult` returns the value, reports a refusal on that field's own path
while sibling fields resolve, and masks a defect. Masked defects are reported to
`Observers`, so they reach the application's logs and traces rather than
Yoga's console. A GraphQL error
normally retains HTTP 200; the framework does not impose a status or error
schema on application outcomes. One HTTP request is one unit, closed after the
response finishes and included in the runtime's drain.

Yoga's wildcard CORS default is disabled here. `HTTP_CORS_ORIGIN` sets the
allowed origin; `cors` on `graphql()` can specify Yoga's full policy, including
credentials, or `false` to disable it explicitly. Yoga's console logger is
disabled so an unexpected resolver error cannot print sensitive details
outside the application's logging path. Pass Yoga `plugins` — inline, or typed
by the context they read as `Plugin<{ unit: … }>` — for validation
rules, depth or complexity limits, and other schema-specific controls before
exposing expensive fields to untrusted callers. A protected mount lets browser
CORS preflights reach Yoga before authentication, and 401/403 refusals receive
the same CORS policy. Plugin resources are disposed when the application stops.

Generate the SDL with
`pnpm --filter @btravstack/example-order-graphql-api graphql:schema`. The
checked-in [schema.graphql](https://github.com/btravstack/btravstack/blob/main/examples/order-graphql-contract/schema.graphql)
is consumable without the gateway or Yoga. Its freshness test detects schema
drift. Expose live introspection or a contract UI according to the deployment's
access policy; the answerer mounts no GraphiQL page by default.

Subscriptions and GraphQL over WebSocket are outside this answerer's scope.
