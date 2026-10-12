---
title: "@btravstack/oauth-client"
description: The complete surface of @btravstack/oauth-client — the TokenSource port, TokenRequest and AccessToken, TokenRefused and TokenIssuerUnavailable, oauthClient() over client credentials or RFC 8693 token exchange, its cache and health check, OAUTH_ISSUER, OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET, and staticTokenSource.
---

<!-- doctest: prelude
import { Module, Port, Provider } from "@btravstack/di";
import { overridden } from "@btravstack/testing";
import { P, type AsyncResult } from "unthrown";
-->

# @btravstack/oauth-client

> **Reference.** A complete, structured description of
> `@btravstack/oauth-client`: the `TokenSource` port a service depends on to
> call another as itself or for a subject, its two modeled errors,
> `oauthClient()` over OAuth 2.0 client credentials or RFC 8693 token exchange,
> and `staticTokenSource` for tests.

The source uses **client credentials** for a service token and **RFC 8693
token exchange** when `onBehalfOf` names a subject credential. The issuer
authorizes delegation and owns the actor claim; no actor id is accepted as a
substitute for a credential.
The recipe is [Call another service as itself](/how-to/call-another-service-as-itself).

```sh
pnpm add @btravstack/oauth-client @btravstack/core @btravstack/config \
  @btravstack/di openid-client unthrown
```

Every dependency is a peer; `openid-client` is required, since the package is
that adapter. Node `>=22.12`, because `openid-client` is ESM-only and the
CommonJS build relies on `require(esm)`.

## The port

<!-- doctest: signature=@btravstack/oauth-client -->

```ts
type TokenRequest = {
  readonly audience: string;
  readonly scope?: string;
  readonly onBehalfOf?: {
    readonly token: string;
    readonly tokenType: string;
    readonly actor?: { readonly token: string; readonly tokenType: string };
  };
};

type AccessToken = {
  readonly bearer: string;
};
```

`TokenSource`'s service is one method,
`token(request: TokenRequest): AsyncResult<AccessToken, TokenRefused | TokenIssuerUnavailable>`.
`audience` is the callee as the authorization server names it — the `aud`
the token is minted for — and `scope` is space-delimited, as OAuth spells it.
For token exchange, `onBehalfOf.token` is the incoming subject token and
`tokenType` is its RFC 8693 type, usually
`urn:ietf:params:oauth:token-type:access_token`. `actor` supplies the acting
service's token and type if the issuer requires `actor_token`. Client
credentials authenticate the service on both grants. The requested output is
always an access token.

```ts
import { type TokenSourceService } from "@btravstack/oauth-client";

declare const tokens: TokenSourceService;
declare const subjectToken: string;
declare const serviceToken: string;

const delegated = tokens.token({
  audience: "orders",
  onBehalfOf: {
    token: subjectToken,
    tokenType: "urn:ietf:params:oauth:token-type:access_token",
    actor: { token: serviceToken, tokenType: "urn:ietf:params:oauth:token-type:access_token" },
  },
});
```

Configure the issuer to authorize delegation and mint the `act` claim naming
the service. An exchange without `actor` may mean impersonation at an issuer;
use its documented policy. Workers receive a subject credential from their
producer, never fabricate one from an actor id. Native delegation is verified
against [Keycloak](https://www.keycloak.org/securing-apps/token-exchange), whose
delegation feature is currently preview; the port is issuer-neutral.

`AccessToken` carries no expiry. Keeping a token is the source's job; a caller
holding the expiry would cache it a second time.

## The two errors

```ts
import { TokenSource } from "@btravstack/oauth-client";

class Inventory extends Port("ReferenceInventory")<{
  readonly bearer: () => AsyncResult<string, "retry later" | "misconfigured">;
}> {}

export const inventory = Provider(Inventory)({
  inject: { tokens: TokenSource },
  sync: ({ tokens }) => ({
    bearer: () =>
      tokens
        .token({ audience: "https://inventory.internal" })
        .map(({ bearer }) => bearer)
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("TokenIssuerUnavailable"), () => "retry later" as const)
            .with(P.tag("TokenRefused"), () => "misconfigured" as const),
        ),
  }),
});
```

- **`TokenRefused`** — `{ audience, error, description }`. The authorization
  server answered with an OAuth error: `invalid_client` for a wrong secret,
  `invalid_scope` for a scope the client was not granted, `invalid_request`
  for an audience it was not granted (as Hydra answers it). A registration or
  a configuration is wrong; asking again will not help. It never carries the
  client secret.
- **`TokenIssuerUnavailable`** — `{ issuer, cause }`. The server could not be
  asked: discovery failed, the network did, or it answered with a server
  error. Transient — the next call asks again.

## `oauthClient(options?)`

```ts
import { oauthClient } from "@btravstack/oauth-client";

export const Gateway = Module("ReferenceGateway")({
  imports: [oauthClient()],
  provides: [inventory],
  exports: [Inventory],
});
```

A module providing `TokenSource` and one `HealthChecks` member, over the
client credentials grant or RFC 8693 exchange (`client_secret_basic`).

| Variable              | Option         | Required | What it is                                                   |
| --------------------- | -------------- | -------- | ------------------------------------------------------------ |
| `OAUTH_ISSUER`        | `issuer`       | yes      | the authorization server, as its discovery document names it |
| `OAUTH_CLIENT_ID`     | `clientId`     | yes      | this service's client id                                     |
| `OAUTH_CLIENT_SECRET` | `clientSecret` | yes      | its secret — set from a Kubernetes Secret                    |

Each variable is pinned by its option; an unset one is a `ConfigInvalid`
naming every missing variable, exit `78` under `runMain`. Two options are not
variables:

- **`allowInsecureIssuer`** (default `false`). An `http:` issuer is refused at
  boot unless it is loopback (`localhost`, `127.0.0.1`, `[::1]`) — the client
  secret and every token would cross the wire in the open. It is an option
  rather than a variable because its silent change is a security regression.
  The rule is `@btravstack/config`'s `cleartext`, the one `oidc()` and
  `jwtAuthenticator` apply.
- **`clock`** (default: the kernel's `systemClock`) — what a token's lifetime
  is measured against; a spec passes `@btravstack/testing`'s fake clock.

**Discovery is lazy.** The first token asks for the issuer's metadata, and a
discovery that failed is asked again by the next call. An authorization server
that is down when a deployment rolls out fails the calls that need a token —
as `TokenIssuerUnavailable` — and not the boot: tokens expire, so the issuer
has to answer during the process's life anyway, and a boot that depended on it
would turn an issuer blip into a crashlooping rollout of a process whose other
routes work. Configuration is still checked at boot.

**A token is kept per audience, scope and subject/actor credentials until a minute before it expires**,
or half its lifetime if that is shorter, so it outlives the request it rides.
A response without `expires_in` is not kept. At most 1024 tokens are retained:
FIFO eviction removes the oldest insertion at capacity, and stale entries are
removed on access. Keys hash every credential and
its token type; changing any of them cannot reuse another subject's token.
The complete request, including nested subject and actor credentials, is
snapshotted when `token()` is called. Its cache key, observation and grant use
that same snapshot, so later caller mutation cannot change the token fetched.
Neither credentials nor subject identities are put in observation details or
health-check reasons.

**Callers asking for the same token while it is being fetched share that one
request.** A failure is never kept.

**Every fetch is reported to `Observers`** — `component: "oauth-client"`,
`name: "token"`, the audience as the bounded dimension
`btravstack.oauth.audience` and the scope as the detail
`btravstack.oauth.scope`. A token served from memory reports nothing.

**The `oauth-client` health check fails while the newest-started fetch for any audience
and scope failed**, naming each one and the issuer's error code, and recovers
when that pair next fetches successfully. Health keys omit credentials, so a
valid replacement clears an obsolete subject token's failure. It is healthy
before the first fetch. It reports
the newest-started fetch's result even when older requests finish afterwards.
Generation markers exist only while their fetch is pending, so completed pairs
retain no generation bookkeeping. It reports
the fetches rather than probing the issuer, because a rotated secret leaves
the issuer reachable and every call refused.

## `staticTokenSource(bearer)`

```ts
import { staticTokenSource } from "@btravstack/oauth-client";

export const TestGateway = overridden(Gateway, [staticTokenSource("test-token")]);
```

A provider of `TokenSource` answering `{ bearer }` for every request, never
failing — the shape `overridden` takes. The overridden root still builds
`oauthClient()`'s configuration, so its environment sets the three variables;
a spec that wants none composes `staticTokenSource` in place of
`oauthClient()` instead.
