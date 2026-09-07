---
title: Protect a procedure
description: Mark a contract fragment or a procedure with authenticated(), declare the security schemes and scopes it accepts, verify a real OIDC token with jwtAuthenticator, read the principal in the handler, and test it against a local issuer.
---

<!-- doctest: prelude
import { Logger } from "@btravstack/core";
import { HttpModule } from "@btravstack/http-server";
import { observability } from "@btravstack/observability";
import { OkAsync, P } from "unthrown";
import type { Order } from "@btravstack/example-order-domain";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { api } from "../../auth.js";
import { createOrderApiClient } from "../../client.js";
import { Module } from "@btravstack/di";
declare const OrdersSlice: Module<
  InstanceType<(typeof ordersController)["port"]>,
  never,
  never
>;
declare const CustomersSlice: Module<
  InstanceType<(typeof customersController)["port"]>,
  never,
  never
>;
const customersController = api.OrpcController(
  {
    customers: {
      find: oc
        .input(z.object({ id: z.uuidv7() }))
        .output(z.object({ name: z.string() })),
    },
  },
  "customers",
)({ inject: {}, sync: () => ({ find: () => OkAsync({ name: "Ada" }) }) });
declare const view: (order: Order) => { id: string; quantity: number };
declare const accessToken: string;
-->

# Protect a procedure

> **How-to.** The lesson that fronts this recipe:
> [Protect the API](/tutorial/protect-the-api).
> Declare in the contract which security schemes a procedure
> accepts and which scopes each must grant, resolve the caller once per
> request, and read it in the handler. For
> the marker's surface, see [`@btravstack/contract`](/reference/contract); for
> the starter's, [`@btravstack/http-server`](/reference/http-server); for the worked
> deployment, [Order API (HTTP)](/examples/order-api).

Three moves, in this order: **mark** the contract, **implement** each scheme,
**mint** the router and controllers from the one call that knows both. The
marker is what makes the rest type-checked — the router provider grows one
dependency per scheme its contract names, and the protected procedures'
handlers grow a `context.principal` typed by the schemes that reach them.

**The contract says _which schemes_ protect a route and _which scopes_ each
must grant; `defineHttp({ authenticators })` says _what each scheme resolves
to_.** No identity type is named in the contract at all, so nothing about the
server's view of a caller reaches a client.

## Recipe

1. Mark the contract with `authenticated(...requirements)`.
2. Compose each scheme — `jwtAuthenticator`, `apiKeyAuthenticator`, or a
   hand-written `HttpAuthenticator<P, Scope>()` — and declare them all in one
   `defineHttp({ authenticators })` call.
3. Read `opts.context.principal` in the handlers of the protected procedures.
4. Compose the root — there is no authenticator to pass.

## Step 1 — mark the contract

The marker goes in the contract package, because it is a fact about the API
that a client should be able to read without taking the server:

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderRef = z.object({ id: z.uuidv7() });

// `BAD_REQUEST` names the id **as received**, which is the one value that is
// not a UUIDv7: `orderRef` would reject the only payload it ever carries.
const malformedRef = z.object({ id: z.string() });

// The group default: every procedure beneath it needs the `user` scheme, with
// no particular scope.
const ordersContract = authenticated({ user: [] })({
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(z.object({ id: z.uuidv7() }))
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: malformedRef },
      CONFLICT: { data: orderRef },
    }),

  find: oc
    .input(orderRef)
    .output(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .errors({ NOT_FOUND: { data: orderRef } }),

  // Replaces the default for itself: a `user` token granting `orders:export`,
  // OR a `service` key with no scopes at all. It names the order it exports,
  // and no tenant — the caller's own credential establishes that.
  export: authenticated(
    { user: ["orders:export"] },
    { service: [] },
  )(oc.input(orderRef).output(z.object({ csv: z.string() }))),
});

const customersContract = {
  find: oc
    .input(z.object({ id: z.uuidv7() }))
    .output(z.object({ name: z.string() })),
};

export const contract = {
  orders: ordersContract,
  customers: customersContract, // public
};
```

Four rules, and they are OpenAPI's own:

- **A requirement is a scheme name mapped to the scopes it must grant.**
  `{ user: [] }` says "present the `user` scheme"; `{ user: ["orders:export"] }`
  adds a scope the credential has to carry.
- **Requirements are ORed**, tried in the order given: the first one a caller
  satisfies wins. `authenticated({ user: [...] }, { service: [] })` means either.
- **A requirement names one scheme**, and `authenticated({ user: [], mtls: [] })`
  does not compile. AND-within-a-requirement is deliberately not modelled —
  requiring two credentials at once would put a record rather than a single
  identity on the handler — and it is refused rather than documented because
  the discrepancy weakens the rule: OpenAPI reads two keys as AND, this
  starter would run them as OR. Where two really are needed, a composite
  scheme models it.
- **Nearest mark wins.** A marked record is the default for every procedure
  beneath it; a marked procedure **replaces** that default for itself rather
  than adding to it.

Apply `authenticated(...)` to a **finished** node — the
last call in a builder chain, or a whole record of finished nodes. Applied
mid-chain it is silently dropped, because `oc.router(...)` rebuilds every node.

The contract stops here. It names no principal, so there is nothing in it to
keep minimal and nothing in it to leak.

## Step 2 — implement each scheme, and declare them together

`HttpAuthenticator<P, Scope>()` implements **one** scheme. It resolves a
credential from the request's **headers** — not the request: an authenticator
has no business reading a body, and the narrower argument is what keeps it
testable without a socket. The scheme's **name** is not stated here; it is the
key the authenticator sits under in `defineHttp`, so it is written once.

**`src/auth.ts`** — one file per application

<!-- doctest: isolate
import { TenantId, TenantIdSchema } from "@btravstack/example-order-domain";
import { apiKeyAuthenticator, defineHttp } from "@btravstack/http-server";
import { jwtAuthenticator, type Claims } from "@btravstack/http-server/jwt";
-->

```ts
import { TenantId, TenantIdSchema } from "@btravstack/example-order-domain";
import { apiKeyAuthenticator, defineHttp } from "@btravstack/http-server";
import { jwtAuthenticator, type Claims } from "@btravstack/http-server/jwt";
/** What the `user` scheme resolves to. The contract names none of this. */
export type Identity = { readonly tenantId: TenantId; readonly userId: string };

/**
 * What the `service` scheme resolves to: which machine is calling, and the
 * tenant its key was cut FOR. A machine has no login to take one from, so the
 * tenant is a property of the credential.
 */
export type ServiceIdentity = {
  readonly appId: string;
  readonly tenantId: TenantId;
};

/**
 * No standard claim carries a tenant, so the name is the issuer's — `tenant`
 * here, `tid` on Entra, `org_id` on Auth0 — and this is the one place this
 * deployment writes it. Answering `undefined` refuses the token.
 */
const principal = (claims: Claims): Identity | undefined => {
  const tenant = claims["tenant"];
  return typeof claims.sub === "string" &&
    claims.sub !== "" &&
    typeof tenant === "string" &&
    TenantIdSchema.safeParse(tenant).success
    ? { tenantId: TenantId(tenant), userId: claims.sub }
    : undefined;
};

/** Nothing pinned, so the three `HTTP_JWT_*` variables are the deployment's. */
export const userAuth = jwtAuthenticator<Identity>()({
  principal,
  scopes: ["orders:export"],
});

/** A key is cut for a tenant the way a login belongs to one, so it is stated here. */
export const serviceKeys = [
  {
    key: "reporting",
    principal: {
      appId: "reporting",
      tenantId: TenantId("0199a1e0-0000-7000-8000-0000000000f1"),
    },
  },
] as const;

export const serviceAuth = apiKeyAuthenticator<ServiceIdentity>()({
  keys: serviceKeys,
});

/** The one door: declaring a scheme and implementing it are the same act. */
export const api = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth },
});
```

**Neither scheme is hand-written, and that is the recommendation.** A JWKS
verification and a constant-time key compare are the two places where writing
it per application is how CVEs happen, so both ship:
[`jwtAuthenticator`](/reference/http-server#the-authenticators-that-ship)
owns the JWKS fetch, its cache and a key rotation, an algorithm allowlist that
is asymmetric-only — a JWKS publishes **public** keys, so accepting `HS256`
beside them is the algorithm-confusion attack — and `iss`, `aud` and `exp`
required to be present; `apiKeyAuthenticator` compares SHA-256 digests rather
than strings, checks every issued key with no early return, and puts a missing
header on the same path as a wrong one. The key list is inline here because an
example has no secret store; a deployment reads it from a config field bound
off `Env`, since a key list in the image is a key list in the repository.

**What stays the application's is `principal(claims)`** — what a verified token
means here. No standard claim carries a tenant, so the name is the issuer's:
`tenant` in this deployment, `tid` on Entra, `org_id` on Auth0, and
`examples/order-api/src/auth.ts` is the one place its own spelling is written.
Answering `undefined` **refuses** the token, which is the hook for a claim this
endpoint requires and the standard does not.

**`jwks`, `issuer` and `audience` are the deployment's, and each option pins
its variable** — `http({ port })`'s own shape against `PORT`. Left unset above,
they bind from `HTTP_JWT_JWKS_URI`, `HTTP_JWT_ISSUER` and `HTTP_JWT_AUDIENCE`;
a variable nobody pinned and nobody set is a `ConfigInvalid` naming it at
**startup** — exit `78` under `runMain` — rather than a 401 for every caller in
production. Those three names belong to the process, so **one JWT scheme reads
them**: a second one in the same graph, against another issuer, pins its own
three at the call. `HTTP_JWT_JWKS_URI` is a
[URL field](/reference/config#fields), so a malformed one is refused with the
variable named rather than defecting at the first request.

**The scope vocabulary is written once**, in `scopes`, and the scheme's scope
type is inferred from it. Only the **principal** is stated
(`jwtAuthenticator<Identity>()`), because inference through a returned
function's `AsyncResult` is where a principal silently widens to `unknown` —
and stating the scopes as a type argument as well is the mistake the option
exists to prevent: `scopes` is optional, so a scheme whose type names
`orders:export` and whose array omits it passes the router's ungrantable-scope
gate and then refuses every caller with a permanent `403`. The granted
list is the **intersection** of the vocabulary with the token's own `scope`
(space-delimited) or `scp` (an array) claim, so a token claiming a scope the
scheme does not know grants nothing extra.

### A scheme neither of those covers

`HttpAuthenticator<P, Scope>()` is the primitive both ship on, and what an
application reaches for when it authenticates against something of its own — a
user directory, a session store, mTLS headers the ingress set:

<!-- doctest: isolate
import { HttpAuthenticator, Unauthenticated, granted } from "@btravstack/http-server";
import { ErrAsync, OkAsync } from "unthrown";
declare const digestOf: (value: string) => string;
declare const partners: ReadonlyMap<string, { readonly appId: string }>;
-->

```ts
export const partnerAuth = HttpAuthenticator<
  { readonly appId: string },
  "orders:export"
>()({
  inject: {},
  sync: () => (headers) => {
    const key = headers["x-partner-key"];
    const partner =
      typeof key === "string" ? partners.get(digestOf(key)) : undefined;
    return partner === undefined
      ? ErrAsync(new Unauthenticated())
      : OkAsync(granted(partner, ["orders:export"]));
  },
});
```

Both type arguments are stated **here**, and for the reason the shipped schemes
infer their second: there is no `scopes` array to infer a vocabulary from, and
inference through the returned function would widen the principal.

A scheme with a scope vocabulary answers `granted(identity, scopes)` — the
helper is mandatory, not advisory, because it stamps a module-private symbol
the walk tests for. A hand-built `{ identity, scopes }` does not type-check,
and the reason it may not is worth knowing: the `Scope` type parameter is
erased at run time, so deciding bare-from-scoped structurally would misread any
identity that happens to carry a `scopes` claim of its own. A scheme
**without** a vocabulary answers the identity bare — which is what a handler
under a single unscoped scheme then reads. The shipped schemes call `granted`
themselves, from the `scopes` array or the matched key's own, which is why
neither fence above mentions it.

Building a scheme can also **fail**, and `make` is the arm for that:
`jwtAuthenticator` is `HttpAuthenticator` over `{ inject: { env: Env }, make }`,
whose `AsyncResult` carries `ConfigInvalid` into the graph's own error channel —
so a scheme configured wrongly fails the boot, still typed, instead of refusing
every caller at run time.

::: warning Hold `api` whole — never destructure it
`const { OrpcController } = defineHttp(...)` is **TS2527**: each binding of a
destructured member expands to a type mentioning `@btravstack/contract`'s
inaccessible `unique symbol`, which the file cannot emit. Held whole, the
inferred type collapses to `Http<A>`, which is nameable — which is why the file
above writes **no type annotation at all**.
:::

Written once per application, because a handler's parameter types are fixed
where the arrow is written: a composition root cannot re-type a `sync` callback
that lives in a slice's module, so the registry has to be in scope where the
handler is.

Enriching what a deployment knows about its callers — roles, an org tier, an
internal id — is a change to this file alone: not a contract change, and none
of it reaches a client.

`api` is also the **only** way a handler gets a readable principal. A marked
fragment reached through anything else types `principal: never` and every read
of it is a compile error — the signal to use the factory, not a fallback.
Neither form invents one: an unmarked procedure's context still has no
`principal` at all.

A scheme that needs a service of its own — a user directory, a key store —
names it in an `inject` record and gets it the way any provider's dependencies
arrive, and that need travels with the authenticator into the graph, so a root
satisfying none is refused at the `HttpModule(...)` call. `Env` is the
exception nobody writes down: `HttpModule` adds it to what its own gate counts
as declared, for **every** provider in the root, so a root composing
`jwtAuthenticator` — or any config-bound scheme — declares no `needs` line for
it. A root composed with di's own `Module(...)` instead does say
`needs: [Env]`, as
[Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) shows.

`Unauthenticated` carries **nothing**: the starter surfaces no reason — a
rejected caller gets an `UNAUTHORIZED` and oRPC's default message — so a payload
would be write-only. An authenticator that wants to record why logs it before
returning, which is one more argument for naming a logger in `inject`.

## Step 3 — read the principal

A protected procedure's handler receives the principal on **oRPC's own context
channel**, `opts.context.principal`. No second parameter, no wrapper. The
controller is minted from the application's own `api`, so the principal has a
readable type — and its **shape follows the requirements**:

| The leaf's requirements name | `context.principal`                           |
| ---------------------------- | --------------------------------------------- |
| one scheme                   | that scheme's identity, **bare**              |
| several schemes              | `{ scheme, identity }`, a discriminated union |
| none (unmarked)              | absent — reading it is a compile error        |

```ts
import { api } from "../../auth.js";

export const ordersController = api.OrpcController(
  contract,
  "orders",
)({
  inject: { logger: Logger },
  // The use cases the `user` kind's fork built over that principal's tenant.
  // `export` names a second scheme, so its kinds are `user | service` and
  // none of these is readable there — which is why it answers from the
  // principal alone.
  unit: { place: PlaceOrder, find: FindOrder },
  sync: ({ logger }) => ({
    // One scheme, so the identity arrives bare — byte-for-byte what a
    // handler wrote before named schemes existed.
    place: ({ errors, context }, input) => {
      logger.info("order placement requested", {
        userId: context.principal.userId,
      });
      return context.unit.place
        .execute(input.id, input.quantity)
        .map(view)
        .mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              errors.INVALID_QUANTITY({
                message: error.message,
                data: { id: error.id },
              }),
            )
            // A malformed id is the caller's mistake, so 400 — not the
            // 409 a duplicate gets.
            .with(P.tag("InvalidOrderId"), (error) =>
              errors.BAD_REQUEST({
                message: error.message,
                data: { id: error.id },
              }),
            )
            .with(P.tag("DuplicateOrder"), (error) =>
              errors.CONFLICT({
                message: error.message,
                data: { id: error.id },
              }),
            ),
        );
    },
    find: ({ errors, context }, input) =>
      context.unit.find
        .execute(input.id)
        .map(view)
        .mapErrCases((matcher) =>
          matcher.with(P.tag("OrderNotFound"), (error) =>
            errors.NOT_FOUND({
              message: error.message,
              data: { id: error.id },
            }),
          ),
        ),
    // Two schemes, so the principal is a discriminated union — `scheme`
    // discriminates and each `identity` is that scheme's own. Whether THIS
    // caller may export THIS order is a further question, and a credential
    // cannot answer it: see Authorize a request.
    export: ({ context }, input) =>
      OkAsync({ csv: `${context.principal.scheme},${input.id}` }),
  }),
});
```

An **unmarked** procedure's `context` has no `principal`, so reading one there
is a compile error — and a controller whose handler reads `context.principal`
cannot be mounted under an unmarked contract key, where nothing would inject
one. The reverse is fine: an unmarked controller under a marked key is a
handler that ignores its caller's identity.

## Step 4 — compose the root

There is **no authenticator to pass**. The authenticators ride the router —
which is what needs them — and `HttpModule` puts them in `provides` itself:

```ts
export const orderRouter = api.OrpcRouter(contract)([
  ordersController,
  customersController,
]);

export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

What is still checked, and it is di's own gate rather than one this package
invented: `OrpcRouter` declares **one dependency per scheme its contract
names**, so a scheme with no authenticator behind it is an unmet need refused
at `start`, and the diagnostic names the port —

```text
{ readonly "UNSATISFIED DEPENDENCIES — nothing provides": "HttpAuthenticator:user" }
```

(The same sentence di's own gate prints at `Module.build`/`Module.scoped`.
`start` checks the need on its `module` parameter, which is why the port is
named — by its id, so a scheme reads as the string the contract declared.)

There is nothing left for a second gate to check. The registry that types the
handlers and the providers that discharge those ports come from the **same**
`defineHttp` call, so they cannot disagree. And an authenticator's own
dependencies reach `NeedsGate` because they are in `provides`, so a root that
imports nothing satisfying a scheme's user directory is refused at the
`HttpModule(...)` call itself — `Env` excepted, which this sugar declares for
the whole root.

## What a rejected caller gets

Requirements are tried in the order the contract declared them, and the first
a caller satisfies wins.

| Situation                                                       | Answer                                                |
| --------------------------------------------------------------- | ----------------------------------------------------- |
| no requirement accepted the caller                              | `401 UNAUTHORIZED`, the handler never entered         |
| a credential was valid but lacked a scope the requirement named | `403 FORBIDDEN`, the handler never entered            |
| an authenticator defects                                        | oRPC's `INTERNAL_SERVER_ERROR` collapse — not a `401` |
| an unmarked procedure, no credentials                           | served                                                |

Neither refusal carries a message: oRPC serializes `message` to the client, and
a refusal has nothing a caller is entitled to. A requirement naming scopes is
**not** satisfied by a credential reporting none — a scheme declared without a
vocabulary answers bare, and admitting it there would admit the caller
outright. A defect is a bug in the authenticator, not a rejected caller: it
stops the walk rather than promoting the caller to the next scheme, and
reporting it as a `401` would tell an operator the opposite of what happened.

On the client, `UNAUTHORIZED` and `FORBIDDEN` are errors the contract does
**not** declare, so they are not inferable: they land in `defect`, not in
`errCases`. A client for a protected fragment sends its credentials up front:

```ts
const client = createOrderApiClient("http://127.0.0.1:3000", "/rpc", {
  authorization: `Bearer ${accessToken}`,
});
```

That token is one your issuer minted. Under test it is `localIssuer`'s, below;
in the local loop it is `pnpm dev:token`'s.

## Testing it

A test that stubs the verification proves the stub.
[`@btravstack/testing/jwt`](/reference/testing#localissuer-options)'s
`localIssuer` is the alternative: a generated key pair, a `node:http` listener
answering its public half as a JWKS document, and a signer holding the private
half — so the scheme does a **real** fetch and a **real** verify, and a token
from another issuer, for another audience, or past its `exp` is refused by
`jose` itself rather than by a double that agrees with the code under test.

Three fixtures, as `examples/order-api/src/__tests__/test-fixtures.ts` writes
them: the issuer, **file-scoped**, since a key pair and a listener are worth
building once per spec file; the boot environment, carrying that issuer's own
values under the names the scheme binds from; and a token for this test's
caller.

<!-- doctest: isolate
import type { Claims } from "@btravstack/http-server/jwt";
import { bootFixture, type Boot } from "@btravstack/testing";
import { localIssuer, type LocalIssuer } from "@btravstack/testing/jwt";
import { uuidv7 } from "uuidv7";
import { test } from "vitest";
-->

```ts
const issuerFixture = async (
  {}: object,
  use: (issuer: LocalIssuer) => Promise<void>,
): Promise<void> => {
  const issuer = await localIssuer({
    issuer: "https://issuer.test",
    audience: "orders-api",
  }).get();
  await use(issuer);
  await issuer.close();
};

export const it = test.extend<{
  issuer: LocalIssuer;
  boot: Boot;
  tenant: string;
  tokenFor: (claims?: Claims) => Promise<string>;
}>({
  issuer: [issuerFixture, { scope: "file" }],

  boot: async ({ issuer }, use) => {
    await bootFixture({
      env: {
        PORT: "0",
        HOST: "127.0.0.1",
        // Nothing is pinned on the scheme, so these three are what it binds
        // itself from — the same three a deployment sets.
        HTTP_JWT_JWKS_URI: issuer.jwks,
        HTTP_JWT_ISSUER: issuer.issuer,
        HTTP_JWT_AUDIENCE: issuer.audience,
      },
    })({}, use);
  },

  tenant: async ({}, use) => {
    await use(uuidv7());
  },

  tokenFor: async ({ issuer, tenant }, use) => {
    await use((claims = {}) =>
      issuer.sign({ sub: "u-1", tenant, ...claims }).get(),
    );
  },
});
```

`sign` answers an `AsyncResult<string, never>`, so it is `.get()` rather than
an unwrap: a channel that cannot fail has no error to handle. Its options
override the issuer, the audience and the expiry per call — `expiresIn: false`
mints a token with no `exp` claim at all — which is one refusal each to assert.
The application itself changes for none of it: the environment is the only
seam, exactly as in production.

## Running it locally

This is the repository's own loop; an application's local issuer is whatever
its identity provider offers for development, or a `localIssuer` started by
hand. Here, `pnpm dev` needs a JWKS endpoint that answers, so `internal/test-infra`'s
`dev:env` starts one beside the other containers and writes the three
`HTTP_JWT_*` variables into `.env.dev`. Its key pair lives under
`<repo>/.cache/dev-issuer/` and is minted once, so a token pasted into a
terminal yesterday still verifies today.

```sh
# mint into a variable and check the status — never `$(…)` straight into the
# header, see below
TENANT=0199a1e0-0000-7000-8000-000000000001 # a UUIDv7
TOKEN=$(pnpm dev:token -- --tenant "$TENANT") || exit

# the port is the one the API's `serving` event logged, PORT=0 in its dev script
curl -s -H "authorization: Bearer $TOKEN" \
     -H 'content-type: application/json' -d '{"json":{}}' \
     http://localhost:57234/rpc/orders/list
```

`--tenant` is required and must be a **UUIDv7**, because `principal` parses it
as one; `uuidgen` and `crypto.randomUUID()` both mint a v4, which comes back as
a `401` rather than as an error naming the mistake. `--sub` defaults to `u-1`
and `--scope` to `orders:export`.

**Mint into a variable, and check the status.** The script writes the token and
nothing else to stdout — but `pnpm` writes its own `[ELIFECYCLE]` line **to
stdout** when a script exits non-zero, and `--silent` does not suppress it. A
`curl -H "authorization: Bearer $(pnpm dev:token …)"` therefore sends that line
as the bearer token on the very mistake the UUIDv7 check exists to catch.
`internal/test-infra/README.md` has the rest.

## The marker is legibility, not enforcement

**An unmarked procedure is public, and nothing fails if the marker is
forgotten.** There is no deny-by-default: a new procedure added to an unmarked
record is served to anyone, no compile error, no startup failure, no warning.
What the contract buys is that a protected route is _visible_ — one call in the
artifact both sides read, in the diff, in the generated types, and in the
handler's own signature.

So the marker is a declaration, not a policy. If you need deny-by-default, it
is the contract's job to say so — mark the root and unmark what is public —
and today that is something an application writes, not something this package
offers.

Two further non-goals worth stating plainly: the marker does not
**authenticate** (that is your authenticator, and what a token means is
yours), and it does not model **resource-dependent authorization**. A **scope**
is the exception, and admitted on the same test authentication passes: it is a
property of the credential, answerable before dispatch. "Is this caller the
order's owner?" is not, and belongs in the handler, where the use case is —
which is layer 3 of
[Authorize a request](/how-to/authorize-a-request), the page that states where
each of the three questions is answered and why.

## See also

- [`@btravstack/contract`](/reference/contract) — `authenticated`,
  `Requirement`, `Requirements`, `Authenticated`, `PrincipalKey`, `IsMarked`,
  `RequirementsOf`, `isAuthenticated`.
- [`@btravstack/http-server`](/reference/http-server) — `defineHttp`, `HttpAuthenticator`,
  `jwtAuthenticator`, `apiKeyAuthenticator`, `granted`, `Granted`, `Principal`,
  `Unauthenticated`, and the request table.
- [`@btravstack/testing`](/reference/testing#localissuer-options) —
  `localIssuer`, the served JWKS and the signer a spec verifies against.
- [Configure from the environment](/how-to/configure-from-the-environment) —
  the three `HTTP_JWT_*` variables beside everything else a deployment sets.
- [Authorize a request](/how-to/authorize-a-request) — the other two layers:
  the tenant in the unit, and the policy the handler decides once it holds the
  resource.
- [Split a router into controllers](/how-to/split-a-router-into-controllers) —
  where the handler in step 3 lives once an API has slices.
- [Order API (HTTP)](/examples/order-api) — one marked fragment, one public
  one, and a procedure that overrides its group's default, end to end.
