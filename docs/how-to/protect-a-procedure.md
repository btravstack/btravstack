---
title: Protect a procedure
description: Mark a contract fragment or a procedure with authenticated(), declare the security schemes and scopes it accepts, implement each scheme with HttpAuthenticator, and read the principal in the handler.
---

<!-- doctest: prelude
import { HttpModule } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";
import { OkAsync, P } from "unthrown";
import type { Order } from "@btravstack/example-order-domain";
import { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import { oc } from "@orpc/contract";
import { z } from "zod";
import { api } from "../../auth.js";
import { createOrderApiClient } from "../../client.js";
import { Module } from "@btravstack/di";
declare const ordersController: typeof piece;
declare const slices: readonly [
  Module<InstanceType<(typeof ordersController)["port"]>, never, never>,
  Module<InstanceType<(typeof customersController)["port"]>, never, never>,
];
const customersController = api.HttpController("CustomersController", {
  find: oc.input(z.object({ id: z.uuidv7() })).output(z.object({ name: z.string() })),
})({}, { sync: () => ({ find: () => OkAsync({ name: "Ada" }) }) });
declare const view: (order: Order) => { id: string; quantity: number };
declare const tenantId: string;
declare const userId: string;
-->

# Protect a procedure

> **How-to.** The lesson that fronts this recipe:
> [Protect the API](/tutorial/protect-the-api).
> Declare in the contract which security schemes a procedure
> accepts and which scopes each must grant, resolve the caller once per
> request, and read it in the handler. For
> the marker's surface, see [`@btravstack/contract`](/reference/contract); for
> the starter's, [`@btravstack/http`](/reference/http); for the worked
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
2. Implement each scheme with `HttpAuthenticator<P, Scope>()`, and declare them
   all in one `defineHttp({ authenticators })` call.
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
  // OR a `service` key with no scopes at all.
  export: authenticated(
    { user: ["orders:export"] },
    { service: [] },
  )(oc.output(z.object({ csv: z.string() }))),
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

<!-- doctest: isolate
import { TenantId } from "@btravstack/example-order-domain";
import { HttpAuthenticator, Unauthenticated, defineHttp, granted } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";
-->

```ts
// src/auth.ts — one file per application
import { TenantId } from "@btravstack/example-order-domain";
import {
  HttpAuthenticator,
  Unauthenticated,
  defineHttp,
  granted,
} from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

/** What the `user` scheme resolves to. The contract names none of this. */
export type Identity = { readonly tenantId: TenantId; readonly userId: string };

/** What the `service` scheme resolves to: a machine caller, no tenant. */
export type ServiceIdentity = { readonly appId: string };

export const userAuth = HttpAuthenticator<Identity, "orders:export">()({
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const [tenantId, userId, ...rest] = token.split(":");
    // Rejoined rather than taken as one field: a scope name contains the
    // delimiter itself, so `orders:export` cannot survive a plain third field.
    const claimed = rest.join(":");
    return tenantId === undefined ||
      tenantId === "" ||
      userId === undefined ||
      userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync(
          granted(
            { tenantId: TenantId(tenantId), userId },
            claimed
              .split(",")
              .filter(
                (scope): scope is "orders:export" => scope === "orders:export",
              ),
          ),
        );
  },
});

export const serviceAuth = HttpAuthenticator<ServiceIdentity>()({
  sync: () => (headers) => {
    const key = headers["x-api-key"];
    return typeof key === "string" && key !== ""
      ? OkAsync({ appId: key })
      : ErrAsync(new Unauthenticated());
  },
});

/** The one door: declaring a scheme and implementing it are the same act. */
export const api = defineHttp({
  authenticators: { user: userAuth, service: serviceAuth },
});
```

A scheme **with** a scope vocabulary answers `granted(identity, scopes)` — the
helper is mandatory, not advisory, because it stamps a symbol the middleware
tests for. A hand-built `{ identity, scopes }` does not type-check, and the
reason it may not is worth knowing: the `Scope` type parameter is erased at run
time, so deciding bare-from-scoped structurally would misread any identity that
happens to carry a `scopes` claim of its own. The granted list is checked
against the declared vocabulary here rather than compared as loose strings at
the endpoint. A scheme **without** one answers the
identity bare — which is exactly what a handler under a single unscoped scheme
then reads.

::: warning Hold `api` whole — never destructure it
`const { HttpController } = defineHttp(...)` is **TS2527**: each binding of a
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

`Bearer <tenantId>:<userId>:<scopes>` is a stand-in, not a recommendation —
what matters is the shape. Neither authenticator here needs a service; a JWT
verifier, a key set or a user directory is named in a `deps` record and
injected the way any provider's dependencies are, so swapping the stand-in for
real verification changes nothing else in the composition — and that
dependency travels with the authenticator into the graph, so a root that
satisfies none is refused at the `HttpModule(...)` call.

Both type arguments are **stated**, never inferred from `sync`: inference
through a returned function's `AsyncResult` is exactly where a principal
silently widens to `unknown`.

`Unauthenticated` carries **nothing**: the starter surfaces no reason — a
rejected caller gets an `UNAUTHORIZED` and oRPC's default message — so a payload
would be write-only. An authenticator that wants to record why logs it before
returning, which is one more argument for naming a logger in `deps`.

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
// slices/orders/controller.ts
import { api } from "../../auth.js";

export const piece = api.HttpController("OrdersController", contract.orders)(
  { place: PlaceOrder, find: FindOrder, logger: Logger },
  {
    sync: ({ place, find, logger }) => ({
      // One scheme, so the identity arrives bare — byte-for-byte what a
      // handler wrote before named schemes existed.
      place: ({ errors, context }, input) => {
        logger.info("order placement requested", {
          userId: context.principal.userId,
        });
        return place
          .execute(context.principal.tenantId, input.id, input.quantity)
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
        find
          .execute(context.principal.tenantId, input.id)
          .map(view)
          .mapErrCases((matcher) =>
            matcher.with(P.tag("OrderNotFound"), (error) =>
              errors.NOT_FOUND({
                message: error.message,
                data: { id: error.id },
              }),
            ),
          ),
      // Two schemes, so the principal is a discriminated union. A missing arm
      // leaves a path returning nothing, which the handler's own return type
      // refuses — the switch is exhaustive or the build fails.
      export: ({ context }) => {
        switch (context.principal.scheme) {
          case "user":
            return OkAsync({
              csv: `user,${context.principal.identity.userId}`,
            });
          case "service":
            return OkAsync({
              csv: `service,${context.principal.identity.appId}`,
            });
        }
      },
    }),
  },
);
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
// module.ts — `ordersController`, `customersController` and `slices` all come
// from the generated ./slices.gen.js
export const orderRouter = api.HttpRouter(contract)({
  orders: ordersController,
  customers: customersController,
});

export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [...slices, observability()],
  exports: [Logger],
});
```

What is still checked, and it is di's own gate rather than one this package
invented: `HttpRouter` declares **one dependency per scheme its contract
names**, so a scheme with no authenticator behind it is an unmet need refused
at `start`, and the diagnostic names the port —

```
Type '"HttpAuthenticator:user"' is not assignable to type '"@di/Scope"'
```

(Not di's `UNSATISFIED DEPENDENCIES` dependency gate — that one guards
`Module.build`/`Module.scoped`; `start` types the need out on its `module`
parameter, which is why the port is named.)

There is nothing left for a second gate to check. The registry that types the
handlers and the providers that discharge those ports come from the **same**
`defineHttp` call, so they cannot disagree. And an authenticator's own
dependencies reach `NeedsGate` because they are in `provides`, so a root that
imports nothing satisfying a `JwtVerifier` is refused at the `HttpModule(...)`
call itself.

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
  authorization: `Bearer ${tenantId}:${userId}:orders:export`,
});
```

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
order's owner?" is not, and belongs in the handler, where the use case is.

## See also

- [`@btravstack/contract`](/reference/contract) — `authenticated`,
  `Requirement`, `Requirements`, `Authenticated`, `PrincipalKey`, `IsMarked`,
  `RequirementsOf`, `isAuthenticated`.
- [`@btravstack/http`](/reference/http) — `defineHttp`, `HttpAuthenticator`,
  `Granted`, `Principal`, `Unauthenticated`, and the request table.
- [Split a router into controllers](/how-to/split-a-router-into-controllers) —
  where the handler in step 3 lives once an API has slices.
- [Order API (HTTP)](/examples/order-api) — one marked fragment, one public
  one, and a procedure that overrides its group's default, end to end.
