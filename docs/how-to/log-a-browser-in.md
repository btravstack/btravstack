---
title: Log a browser in
description: A session cookie from an OpenID Connect login, the fragments it unlocks, and where the tenant claim comes from on five providers.
---

<!-- doctest: prelude
import { RequestModule } from "../../request-scope.js";
-->

# Log a browser in

> **How-to.** Compose the third shipped scheme — the session cookie an
> OpenID Connect login answerer seals — beside the bearer token and the API
> key, so a browser can reach a fragment route the same way a client reaches
> a marked procedure. For the scheme and the answerer's full surface, see
> [`@btravstack/http-server`](/reference/http-server); for the worked
> deployment, [Order API (HTTP)](/examples/order-api).

## What you get

A browser navigates to a fragment route, is refused, and is sent to
`/auth/login`; it logs in at the identity provider and comes back holding
`__Host-session`. Every fragment route marked `requires: [{ session: [] }]`
reads that cookie the same way a marked procedure reads a bearer token — the
same `resolvePrincipal` walk, the same `context.principal`. The application
holds no session store of its own: the cookie, encrypted and stamped with its
own lifetime, **is** the session.

## Recipe

1. Declare the scheme — `sessionAuthenticator<Identity>()({ scopes })`, over
   the same identity the bearer scheme resolves, beside it in one `defineHttp`
   call.
2. Bind the kind — `SessionModule`, `UserModule`'s own shape over
   `auth.principals.session` instead of `.user`.
3. Compose the codec and the answerer — `sessionCodec()` and
   `oidc({ principal, scope })`, both in the root's `provides`.
4. Require `session` on the route — `requires: [{ session: [] }]` on
   `api.HtmxGet`, exactly where a procedure would name `user`.
5. Set `fragmentsLogin` — the route a caller with no session is sent to.

## Step 1 — the scheme

`auth.ts` is the one file that says what a caller is, on every scheme. The
third is `sessionAuthenticator`, over the same `Identity` the bearer scheme
resolves — a browser that logged in **is** a user, so nothing new is stated
about what it means to be one:

```ts
import { TenantId, TenantIdSchema } from "@btravstack/example-order-domain";
import { apiKeyAuthenticator, defineHttp } from "@btravstack/http-server";
import { jwtAuthenticator, type Claims } from "@btravstack/http-server/jwt";
import { sessionAuthenticator } from "@btravstack/http-server/session";
import type { IDToken } from "openid-client";

export type Identity = { readonly tenantId: TenantId; readonly userId: string };
export type ServiceIdentity = { readonly appId: string; readonly tenantId: TenantId };

/**
 * Two doors read this: the bearer scheme's verified token, and the ID token
 * the login answerer hands back — which is why it takes either claim set,
 * and why the tenant claim is named here once for both.
 */
export const principal = (claims: Claims | IDToken): Identity | undefined => {
  const tenant = claims["tenant"];
  return typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof tenant === "string" &&
    TenantIdSchema.safeParse(tenant).success
    ? { tenantId: TenantId(tenant), userId: claims.sub }
    : undefined;
};

export const userAuth = jwtAuthenticator<Identity>()({ principal, scopes: ["orders:export"] });

export const serviceKeys = [
  {
    key: "reporting",
    principal: { appId: "reporting", tenantId: TenantId("0199a1e0-0000-7000-8000-0000000000f1") },
  },
] as const;
export const serviceAuth = apiKeyAuthenticator<ServiceIdentity>()({ keys: serviceKeys });

/**
 * The third scheme: the session cookie the login answerer seals. The same
 * `Identity` as `user`, because a browser that logged in IS a user — only the
 * credential differs, a cookie in place of a bearer token.
 */
export const browserAuth = sessionAuthenticator<Identity>()({ scopes: ["orders:export"] });

export const auth = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth, session: browserAuth },
});
```

`principal` is shared between two doors — `userAuth`'s verified token and
`oidc()`'s ID token — which is why it takes `Claims | IDToken` rather than
either alone. The tenant claim, `claims["tenant"]`, is named here **once**
for both, so a browser and a machine cannot end up disagreeing about where
the tenant is written. See [Protect a procedure](/how-to/protect-a-procedure)
for the same file without the third scheme.

## Step 2 — the kind

A scheme is who the caller is; a **kind** is what a request opens over it.
`SessionModule` is `UserModule`'s own shape — the same `Tenant` provider, the
same vertical composed on top — over `auth.principals.session` instead of
`.user`: a browser that logged in is a user, so nothing about the vertical
changes, only the credential does. `auth.units<…>()` is the second, separate
step that retypes `auth` by the kind each scheme binds — separate because
`SessionModule` names `auth.principals.session` in its own `needs`, so folding
the two together would make them mutually recursive:

```ts
import { Module, Provider } from "@btravstack/di";
import {
  FindOrder,
  ListOrders,
  OrderApplicationModule,
  PlaceOrder,
  Tenant,
} from "@btravstack/example-order-application";
import { OrderTenantPersistence } from "@btravstack/example-order-infrastructure";

export const SessionModule = Module("Session")({
  needs: [auth.principals.session],
  imports: [RequestModule, OrderTenantPersistence, OrderApplicationModule],
  provides: [
    Provider(Tenant)({
      inject: { principal: auth.principals.session },
      sync: ({ principal }) => principal.tenantId,
    }),
  ],
  exports: [RequestModule, Tenant, PlaceOrder, FindOrder, ListOrders],
});

export const api = auth.units<{ session: typeof SessionModule }>();
```

## Step 3 — the root

The composition root supplies the codec that seals and unseals the cookie,
and the login answerer that walks the OpenID Connect flow — both in
`provides`, beside the fragment they ride. `orderRowFragment` is in there
too: this single-file root has no slice import to discharge the route's own
port, so it provides it directly — in `examples/order-api` that job belongs
to the `OrdersSlice` module instead.

<!-- doctest: defer -->

```ts
import { Logger, Meter, Tracer } from "@btravstack/core";
import { OrderDatabase, OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { HttpModule } from "@btravstack/http-server";
import { oidc } from "@btravstack/http-server/oidc";
import { sessionCodec } from "@btravstack/http-server/session";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";

export const BrowserApi = HttpModule("BrowserApi")({
  fragments: api.HtmxFragments([orderRowFragment]),
  fragmentsLogin: "/auth/login",
  unit: { session: SessionModule },
  provides: [
    orderRowFragment,
    sessionCodec(),
    oidc({ principal, scope: "openid orders:export" }),
  ],
  imports: [OrderPersistenceModule, observability(), otel()],
  exports: [Logger, Tracer, Meter, OrderDatabase],
});
```

Five environment variables, each read when the matching option is left
unset:

| Variable                                                            | What it's for                            |
| ------------------------------------------------------------------- | ---------------------------------------- |
| [`HTTP_SESSION_KEYS`](/how-to/configure-from-the-environment)       | `sessionCodec()`'s own keys              |
| [`HTTP_OIDC_ISSUER`](/how-to/configure-from-the-environment)        | the provider `oidc()` discovers          |
| [`HTTP_OIDC_CLIENT_ID`](/how-to/configure-from-the-environment)     | this deployment's client                 |
| [`HTTP_OIDC_CLIENT_SECRET`](/how-to/configure-from-the-environment) | its secret — a confidential client       |
| [`HTTP_OIDC_REDIRECT_URI`](/how-to/configure-from-the-environment)  | the URI **registered** with the provider |

## Step 4 — the route

`requires: [{ session: [] }]` marks a fragment route exactly where a marked
procedure would name `user`:

```ts
import { FindOrder } from "@btravstack/example-order-application";
import { html } from "@btravstack/http-server";
import { P } from "unthrown";

export const orderRowFragment = api.HtmxGet("/orders/:id/row", { requires: [{ session: [] }] })({
  inject: {},
  unit: { find: FindOrder },
  sync: () => (context, params) =>
    context.unit.find
      .execute(params.id)
      .map((order) => html`<tr id="order-${order.id}"><td>${order.quantity}</td></tr>`)
      .recoverErrCases((matcher) =>
        matcher.with(P.tag("OrderNotFound"), () => html`<tr><td>not found</td></tr>`),
      ),
});
```

The JSON procedures — `orders.place`, `orders.find`, `orders.export` — keep
`requires: [{ user: [] }]` (and, for `export`, `service`): a token is still
what a client presents. Only a browser's own fragment route takes the
cookie.

## What a browser sees

A **browser navigating** to a marked fragment with no session gets
`303 Location: /auth/login?return=%2Forders%2F42%2Frow` — the path it asked
for, carried back for the redirect after login. **htmx's own request** — one
carrying `HX-Request: true` — gets `401` with `HX-Redirect` naming the same
URL instead, so the browser navigates the window rather than swapping the
login page into whatever the fragment targeted. A caller who is **logged in
and lacks the scope** still gets `403`, sent through the login or not: it
already completed one. The mechanics — why `303` and not `302`, the
`return` guard against an off-site redirect — are
[Serve htmx fragments](/how-to/serve-htmx-fragments#send-an-unauthenticated-caller-to-log-in).

## Logging out

`POST /auth/logout` clears `__Host-session` and redirects to the provider's
own end-session endpoint, or to `postLogout` when it advertises none. It
takes no parameters: the cookie carries a principal and no token, so there is
no `id_token_hint` to send and nothing to look up. It is a `POST` because it
is a state change, so the CSRF check a composed session scheme turns on
covers it like any other cookie-bearing one.

## Testing it

`test-fixtures.ts`'s `browser` fixture logs a fresh identity in through the
real provider — `createIdentity`, then a headless walk against `/auth/login`
and `/auth/callback` — and hands back the cookie header and the tenant that
identity belongs to. `headlessLogin` is Ory-specific and lives in
`internal/test-infra`, not in this package: a real deployment's provider has
its own login page, and nothing here drives one. The identity is minted per
test, the same boundary a tenant or a vhost is elsewhere in this repository —
nothing is cleaned up, because nothing is shared.

<!-- doctest: skip — an excerpt of src/fragments.spec.ts, which the gate compiles and runs -->

```ts
it(
  "renders the order row to a browser holding the session its login sealed",
  async ({ serve, browser, clientWith, tokenFor, originFor, orderId, api }) => {
    // GIVEN a browser logged in through the provider, and an order placed
    // under that browser's own tenant through the JSON API
    const app = serve(api);
    const { cookie, tenant } = await browser(app);
    const client = await clientWith(app, `Bearer ${await tokenFor({ tenant })}`);
    await client.orders.place({ id: orderId, quantity: 2 });

    // WHEN the fragment route is requested with the cookie and nothing else —
    // the route's own path names only `id`, and the tenant comes off the session
    const response = await request(await originFor(app))
      .get(`/orders/${orderId}/row`)
      .set("cookie", cookie);

    // THEN the rendered row carries the order, over a plain HTML response
    expect({ status: response.status, body: response.text }).toEqual({
      status: 200,
      body: `<tr id="order-${orderId}"><td>2</td></tr>`,
    });
  },
  LOGIN,
);
```

## Locally

`pnpm dev` runs the real deployment; `pnpm dev:login` is `dev:token`'s
browser sibling — the same headless walk the specs use, against the running
`order-api`, printing the `__Host-session` cookie on stdout:

```sh
COOKIE=$(pnpm dev:login -- --as alice@btravstack.test) && \
  curl -s -b "$COOKIE" http://localhost:3000/orders/0199a1e0-0000-7000-8000-000000000001/row
```

The gate's own identity provider has no login page, on purpose — its UI URLs
are deliberately dead, so nothing but a headless walk can complete the round
trip against it. A real deployment's provider has one, and a real browser
uses it directly; `dev:login` exists only because this one does not.

## Which provider

`principal(claims)` is the one place a claim becomes a tenant, and every
provider spells the claim differently:

| Provider    | Issuer shape                                         | The tenant claim                                                                         |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Ory Network | `https://<project>.projects.oryapis.com`             | a trait on the Kratos identity, copied into the ID token by your consent app             |
| Keycloak    | `https://<host>/realms/<realm>`                      | a realm per tenant (the issuer IS the tenant), or a user attribute mapped into the token |
| Entra ID    | `https://login.microsoftonline.com/<tenant-id>/v2.0` | `tid`, always present                                                                    |
| Auth0       | `https://<domain>/`                                  | `org_id` with Organizations, else a custom namespaced claim from an Action               |
| Authelia    | `https://<host>`                                     | no tenant concept: a group claim, or one Authelia per tenant                             |

`principal` is where the spelling is chosen, once — and for ONE provider. The
example's reads `claims["tenant"]` because that is what its consent app
writes; against Entra it reads `claims["tid"]`, against Auth0
`claims["org_id"]`, and the rest of the function stays as it is. It does not
try every spelling in turn: a deployment talks to one issuer, and a function
that recognised five would answer a tenant for a claim nobody configured. A
provider that cannot put a tenant on the token is one where `principal`
answers `undefined` and the login is refused with `400` —
`principal_refused` — rather than a session with no tenant. A loopback `http:` issuer needs nothing: it is the dev loop.
Any other `http:` issuer is refused at boot unless `allowInsecureIssuer: true`
is pinned at the `oidc()` call.

## See also

- [`@btravstack/http-server`](/reference/http-server#the-session-cookie) —
  `sessionCodec`, `sessionAuthenticator`, `SESSION_COOKIE` and the cookie's own
  guarantees.
- [`oidc()`](/reference/http-server#the-login-answerer) — the three routes,
  every option, and the five refusal reasons.
- [Serve htmx fragments](/how-to/serve-htmx-fragments) — the fragment route
  itself, `requires`, and the redirect mechanics in full.
- [Protect a procedure](/how-to/protect-a-procedure) — the bearer and API-key
  schemes, and `auth.ts` without the third.
- [Authorize a request](/how-to/authorize-a-request) — the tenant and the
  policy layer underneath the scheme.
