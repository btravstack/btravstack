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
`/oidc`. Opt-in `/oidc-tokens` retains delegated access, refresh and ID tokens in
application-supplied shared storage, with refresh and logout serialized across
replicas. Pass its manager port to both the login and session authenticator;
credentials stay out of the principal and session cookie. Set
`oidc()`'s `postLogoutRedirectUri` or `HTTP_OIDC_POST_LOGOUT_REDIRECT_URI` to a
provider-registered absolute return URI to enable RP-initiated logout. The login
uses the retained ID token only as the provider's logout hint, after atomically
deleting the credentials. Without that setting, logout keeps its existing
parameterless behavior. See [server-side OIDC tokens](https://btravstack.github.io/btravstack/reference/http-server#server-side-oidc-tokens).

`protectedResource()` publishes Protected Resource Metadata (RFC 9728)
for one resource, `protectedResourcePerHost()` for one per served host. See [the HTTP reference](https://btravstack.github.io/btravstack/reference/http-server)
for request units, security, configuration and shutdown behavior.

Application authenticators can return `AuthenticatorUnavailable` when a
dependency cannot decide. It stops the authentication walk and every HTTP
answerer returns `503`, reporting the scheme through `Observers`. See
[authentication dependency outages](https://btravstack.github.io/btravstack/reference/http-server#authentication-dependency-outages).

Request-scoped providers may inject `HttpRequestMetadata` to decode headers,
method and URL independently of authentication. The runtime seeds its immutable
snapshot and cancellation signal once per request unit; it is unavailable in
application-scoped providers. See the [HTTP reference](https://btravstack.github.io/btravstack/reference/http-server#non-authentication-request-metadata).

`jwtVerifier()` on `/jwt` provides cached signed-evidence verification independently
of an HTTP authentication scheme. Inject `JwtVerifier` and supply the expected
audience on each `verify({ token, audience })` call; issuer and JWKS trust remain
fixed at startup. See [signed evidence](https://btravstack.github.io/btravstack/reference/http-server#signed-evidence-for-another-recipient).

## JWT verifier options

- `issuer`: pins the required issuer.
- `jwks`: pins the trusted key-set endpoint.
- `variablePrefix`: names the issuer/JWKS environment prefix.
- `algorithms`: pins the signature allowlist.
- `clockToleranceSec`: pins expiry/not-before leeway.
- `allowInsecureJwks`: explicitly permits non-loopback cleartext development keys.
- `port`: names a second issuer's verifier capability.

Defaults and configuration semantics are in the [HTTP reference](https://btravstack.github.io/btravstack/reference/http-server#signed-evidence-for-another-recipient).

## Listener options

- `port`, `hostname`: bind the listener.
- `headersTimeoutMs`, `requestTimeoutMs`: bound request reception.
- `keepAliveTimeoutMs`: bound idle reusable connections after a response.
- `keepAliveTimeoutBufferMs`: extend the actual keepalive lifetime beyond its advertised budget.
- `socketTimeoutMs`: bound inactivity during request and response progress.

Each has a matching environment variable; defaults, zero semantics and Node
compatibility are in the [HTTP reference](https://btravstack.github.io/btravstack/reference/http-server#httpconfig-and-the-environment).
