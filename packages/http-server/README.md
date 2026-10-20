# @btravstack/http-server

The protocol-neutral Node HTTP runtime for `@btravstack/core`. It owns the
listener, `HttpHandler` set port, one unit per request, authentication helpers,
readiness, and graceful drain. Each protocol contributes a handler from its
own package:

- [`@btravstack/orpc-server`](../orpc-server) for contract-first oRPC and OpenAPI routes.
- [`@btravstack/htmx-server`](../htmx-server) for escaped HTML fragments.
- [`@btravstack/graphql-server`](../graphql-server) for a Yoga schema.

Choose the answerer packages for the deployment. The
[order API](../../examples/order-api) runs oRPC and htmx; the
[GraphQL gateway](../../examples/order-graphql-api) runs separately and calls
the order API through its client package.

```sh
pnpm add @btravstack/http-server @btravstack/core @btravstack/config \
  @btravstack/di unthrown
```

The HTTP runtime is composed by `HttpModule` (`@btravstack/orpc-server`) or
`GraphqlModule` (`@btravstack/graphql-server`); its `HttpHandler` members route
by longest matching prefix. `defineAuth()` names shared schemes without choosing a
protocol. JWT, session and OIDC helpers remain on `/jwt`, `/session` and
`/oidc`. Opt-in `/oidc-tokens` retains delegated access and refresh tokens in
application-supplied shared storage, with refresh and logout serialized across
replicas. Pass its manager port to both the login and session authenticator;
credentials stay server-side. `protectedResource()` publishes Protected Resource Metadata (RFC 9728)
for one resource, `protectedResourcePerHost()` for one per served host. See [the HTTP reference](https://btravstack.github.io/btravstack/reference/http-server)
for request units, security, configuration and shutdown behavior.
