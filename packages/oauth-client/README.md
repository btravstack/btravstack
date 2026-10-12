# @btravstack/oauth-client

> A `TokenSource` port for [`@btravstack/core`](../core): a bearer token so a
> service calls another as itself or for a subject, over client credentials
> or RFC 8693 token exchange — kept per audience until shortly before it expires, one fetch shared
> by concurrent callers, and a static adapter for tests.

📖 **[Documentation](https://btravstack.github.io/btravstack/reference/oauth-client)** ·
[API Reference](https://btravstack.github.io/btravstack/api/oauth-client/)

```sh
pnpm add @btravstack/oauth-client @btravstack/core @btravstack/config \
  @btravstack/di openid-client unthrown
```

Every dependency is a peer. Node `>=22.12`: `openid-client` is ESM-only, so
the CommonJS build relies on `require(esm)`.

## A worked example

<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import type { AsyncResult } from "unthrown";
-->

A port that needs a token for the inventory service, and the composition that
provides one:

```ts
import {
  TokenSource,
  oauthClient,
  type TokenIssuerUnavailable,
  type TokenRefused,
} from "@btravstack/oauth-client";

class InventoryAuth extends Port("ReadmeInventoryAuth")<{
  readonly header: () => AsyncResult<string, TokenRefused | TokenIssuerUnavailable>;
}> {}

export const inventoryAuth = Provider(InventoryAuth)({
  inject: { tokens: TokenSource },
  sync: ({ tokens }) => ({
    header: () =>
      tokens
        .token({ audience: "https://inventory.internal", scope: "inventory:read" })
        .map(({ bearer }) => `Bearer ${bearer}`),
  }),
});

export const Gateway = Module("ReadmeGateway")({
  imports: [oauthClient()],
  provides: [inventoryAuth],
  exports: [InventoryAuth],
});
```

Putting the token on an oRPC client's `Authorization` header, without a
`Promise` leaving the `Result`, is
[Call another service as itself](https://btravstack.github.io/btravstack/how-to/call-another-service-as-itself).

## Options

| Option                | Where                                 | What it is                                                      |
| --------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `OAUTH_ISSUER`        | environment, pinned by `issuer`       | the authorization server — required                             |
| `OAUTH_CLIENT_ID`     | environment, pinned by `clientId`     | this service's client — required                                |
| `OAUTH_CLIENT_SECRET` | environment, pinned by `clientSecret` | its secret, from a Kubernetes Secret — required                 |
| `allowInsecureIssuer` | `oauthClient({ … })`                  | accept an `http:` issuer that is not loopback (default `false`) |
| `clock`               | `oauthClient({ … })`                  | what a token's lifetime is measured against                     |

The full table — defaults, semantics and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/oauth-client),
which is this list's one detailed home.

## What it decides, and what it does not

**It decides** that discovery is lazy, so an issuer down at deploy fails the
calls that need a token rather than the boot; that a token is reused until a
minute before it expires, with fixed FIFO capacity so subject turnover stays
bounded; that a refusal (`TokenRefused`, with the issuer's
`error` code) and an outage (`TokenIssuerUnavailable`) are two typed errors;
that every fetch is reported to `Observers`; and that an `oauth-client` health
check follows the newest-started fetch per audience and scope, even when
responses finish out of order. Each request is snapshotted at entry so caller
mutation cannot change its grant or poison another credential's cache.

**It does not decide** what a failure means for your call — retrying belongs
to your transport. On behalf of a subject, `token({ audience, onBehalfOf:
{ token, tokenType, actor? } })` uses RFC 8693 exchange. The issuer must
authorize delegation and mint the `act` claim; an actor credential is supplied
when it requires one. The reasoning is in
[`AGENTS.md`](./AGENTS.md).

## License

MIT
