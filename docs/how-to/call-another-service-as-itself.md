---
title: Call another service as itself
description: Fetch an OAuth 2.0 client credentials token for another service with @btravstack/oauth-client, and put it on an oRPC client's Authorization header without leaving the Result.
---

# Call another service as itself

> **How-to.** A service calling another one presents a bearer token that names
> it. `@btravstack/oauth-client` fetches that token over the client
> credentials grant, keeps it until shortly before it expires, and hands it to
> the call — an oRPC client here — without a `Promise` ever leaving the
> `Result`.

This is the service's **own** identity. A call made for the user who triggered
the work is the same source asked with `onBehalfOf` — an RFC 8693 token
exchange that keeps the user as the subject. Whether the issued token also
names this service in an `act` claim is the issuer's policy, not something
the exchange guarantees; see [the reference](/reference/oauth-client).

## Register the client

At the authorization server, register a confidential client for this service
with the `client_credentials` grant, the callee's audience and the scopes it
may ask for. On Ory Hydra that is one admin call:

```sh
curl -X POST "$HYDRA_ADMIN/admin/clients" -H 'content-type: application/json' -d '{
  "client_id": "order-gateway",
  "client_secret": "…",
  "grant_types": ["client_credentials"],
  "audience": ["https://inventory.internal"],
  "scope": "inventory:read",
  "token_endpoint_auth_method": "client_secret_basic"
}'
```

Install the package — every dependency is a peer:

```sh
pnpm add @btravstack/oauth-client @btravstack/core @btravstack/config \
  @btravstack/di openid-client unthrown
```

## Hand the token to the call

The callee's contract is what an oRPC client is typed by. Give the client a
**context** carrying the bearer, and have its link turn that into the
`Authorization` header. The token is then an ordinary argument of the call, so
the call site fetches it first and chains — the token's errors and the call's
travel one `Err` channel:

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { TokenSource, oauthClient, type TokenSourceService } from "@btravstack/oauth-client";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { oc, type RouterContractClient } from "@orpc/contract";
import { createResultClient } from "@unthrown/orpc/client";
import { z } from "zod";

const inventoryContract = {
  stock: oc.input(z.object({ sku: z.string() })).output(z.object({ available: z.number() })),
};

/** What every call to the inventory carries: the token it was fetched. */
type Caller = { readonly bearer: string };

const inventoryClient = createResultClient(
  createORPCClient<RouterContractClient<typeof inventoryContract, Caller>>(
    new RPCLink<Caller>({
      origin: "https://inventory.internal",
      url: "/rpc",
      headers: ({ context }) => ({ authorization: `Bearer ${context.bearer}` }),
    }),
  ),
  { contract: inventoryContract },
);

const INVENTORY = "https://inventory.internal";

const inventoryOf = (tokens: TokenSourceService) => ({
  available: (sku: string) =>
    tokens
      .token({ audience: INVENTORY, scope: "inventory:read" })
      .flatMap(({ bearer }) => inventoryClient.stock({ sku }, { context: { bearer } }))
      .map(({ available }) => available),
});

export class Inventory extends Port("Inventory")<ReturnType<typeof inventoryOf>> {}

export const inventory = Provider(Inventory)({
  inject: { tokens: TokenSource },
  sync: ({ tokens }) => inventoryOf(tokens),
});

export const Gateway = Module("Gateway")({
  imports: [oauthClient()],
  provides: [inventory],
  exports: [Inventory],
});
```

`available`'s error channel is `TokenRefused | TokenIssuerUnavailable` beside
the callee's own `ORPCError`s, so a triage site folds them together with
`mapErrCases`. A `TokenRefused` is a registration or configuration to fix; a
`TokenIssuerUnavailable` is transient, and the next call asks again.

**Why not a `headers` function that fetches the token itself?** oRPC's
`headers` may be `async`, so it could — but it would have to turn a refusal
into a missing header (and the callee's `401` would hide why) or into a
rejection, and a `Promise` leaving the `Result` is what this framework's
async surfaces never do. Fetching first keeps the reason typed. Calls are
cheap after the first: the source keeps the token, and concurrent callers
share one fetch.

## Configure the deployment

| Variable              | What it is                                               |
| --------------------- | -------------------------------------------------------- |
| `OAUTH_ISSUER`        | the authorization server, as its discovery document says |
| `OAUTH_CLIENT_ID`     | `order-gateway`                                          |
| `OAUTH_CLIENT_SECRET` | from a Kubernetes Secret, never the image                |

All three are validated as the graph is built; an unset one is exit `78`
naming it. An `http:` issuer is refused unless it is loopback — the secret
would cross the wire in the open — and `allowInsecureIssuer: true` at
`oauthClient()` is the deliberate override. Every option and default is on
[the reference page](/reference/oauth-client).

The issuer is not asked at boot. If it is down while you roll out, the new
pods start and the calls that need a token answer `TokenIssuerUnavailable`
until it is back; `/healthz`'s `oauth-client` component names the failing
audience meanwhile.

## Test it

A spec swaps the token source for one that answers a fixed bearer and never
fails:

```ts
import { staticTokenSource } from "@btravstack/oauth-client";
import { overridden } from "@btravstack/testing";

export const TestGateway = overridden(Gateway, [staticTokenSource("test-token")]);
```

The overridden root still reads the three variables, because the rest of
`oauthClient()` is still built; set `OAUTH_ISSUER` to any valid URL (it is
validated, never contacted) and the two credentials to any non-empty string, or compose
`staticTokenSource("test-token")` in a test root in place of `oauthClient()`.
