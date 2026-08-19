---
title: Protect a procedure
description: Mark a contract fragment or a procedure with authenticated(), write the Authenticator that resolves a principal from the request headers, and hand it to HttpModule.
---

# Protect a procedure

> **How-to.** Declare in the contract that a procedure needs an authenticated
> caller, resolve that caller once per request, and read it in the handler. For
> the marker's surface, see [`@btravstack/contract`](/reference/contract); for
> the starter's, [`@btravstack/http`](/reference/http); for the worked
> deployment, [Order API (HTTP)](/examples/order-api).

Three moves, in this order: **mark** the contract, **write** the
`Authenticator`, **pass** it to `HttpModule`. The marker is what makes the
other two type-checked — the router provider grows a dependency on the
authenticator port, and the marked procedures' handlers grow a
`context.principal` typed with the identity the application stated.

**The contract says _whether_ a route is protected; `httpAuth<Identity>()` says
_what_ the principal is.** No identity type is named in the contract at all, so
nothing about the server's view of a caller reaches a client.

## Recipe

1. Mark the contract with `authenticated`.
2. State the server's own identity once with `httpAuth<Identity>()`, and write
   the authenticator it hands back — headers in,
   `AsyncResult<Identity, Unauthenticated>` out.
3. Read `opts.context.principal` in the handlers of the marked procedures.
4. Pass the provider as `HttpModule(name)({ router, authenticator })`.

## Step 1 — mark the contract

The marker goes in the contract package, because it is a fact about the API
that a client should be able to read without taking the server:

```ts
import { authenticated } from "@btravstack/contract";
import { oc, type } from "@orpc/contract";

const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<{ readonly id: string }>()),
};

const customersContract = {
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<{ readonly name: string }>()),
};

export const contract = {
  orders: authenticated(ordersContract), // every procedure beneath it
  customers: customersContract, // public
};
```

A marked **record** protects every procedure beneath it; a marked **procedure**
protects itself, so `{ find, quote: authenticated(quoteProcedure) }` is a
fragment with one of each. Apply `authenticated` to a **finished** node — the
last call in a builder chain, or a whole record of finished nodes. Applied
mid-chain it is silently dropped, because `oc.router(...)` rebuilds every node.

The contract stops here. It names no principal, so there is nothing in it to
keep minimal and nothing in it to leak.

## Step 2 — state the identity, and write the authenticator

`httpAuth<Identity>()` is where the principal's type is stated — one file per
application, which hands back `HttpController`, `HttpRouter` and
`HttpAuthenticator` all fixed to that identity:

```ts
// src/auth.ts
import {
  httpAuth,
  type HttpAuthenticatorOf,
  type HttpControllerOf,
  type HttpRouterOf,
} from "@btravstack/http";

/** What this deployment knows about a caller. The contract names none. */
export type Identity = { readonly tenantId: string; readonly userId: string };

const identity = httpAuth<Identity>();

export const HttpController: HttpControllerOf<Identity> =
  identity.HttpController;
export const HttpRouter: HttpRouterOf<Identity> = identity.HttpRouter;
export const HttpAuthenticator: HttpAuthenticatorOf<Identity> =
  identity.HttpAuthenticator;
```

Written once per application, because a handler's parameter types are fixed
where the arrow is written: a composition root cannot re-type a `sync` callback
that lives in a slice's module, so the identity has to be in scope where the
handler is. The three aliases are annotations rather than ceremony — a
controller's port expands to a type carrying the marker's phantom
`unique symbol`, which the file's own `.d.ts` cannot name.

`HttpAuthenticator([deps], { sync })` is then an ordinary di provider on the
starter's `AuthenticatorPort`, with no type argument left to state. It resolves
the identity from the request's **headers** — not the request: an authenticator
has no business reading a body, and the narrower argument is what keeps it
testable without a socket.

```ts
import { Unauthenticated } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

import { HttpAuthenticator } from "./auth.js";

export const bearerAuthenticator = HttpAuthenticator([], {
  sync: () => (headers) => {
    const header = headers.authorization ?? "";
    const token = header.startsWith("Bearer ")
      ? header.slice("Bearer ".length)
      : "";
    const [tenantId, userId] = token.split(":");
    return tenantId === undefined ||
      tenantId === "" ||
      userId === undefined ||
      userId === ""
      ? ErrAsync(new Unauthenticated())
      : OkAsync({ tenantId, userId });
  },
});
```

Enriching what a deployment knows about its callers — roles, an org tier, an
internal id — is a change to this file alone: not a contract change, and none
of it reaches a client.

The factory is also the **only** way a handler gets a readable principal.
`@btravstack/http`'s own top-level `HttpController` and `HttpRouter` name no
identity, so a marked fragment reached through them types `principal: never`
and every read of it is a compile error — the signal to use the factory, not a
fallback. Neither form invents one: an unmarked procedure's context still has
no `principal` at all.

`Bearer <tenantId>:<userId>` is a stand-in, not a recommendation — what
matters is the shape. `[]` because this one needs no service; a JWT verifier, a
key set or a user directory is named there and injected the way any provider's
dependencies are, so swapping the stand-in for real verification changes
nothing else in the composition.

The identity is **stated**, never inferred from `sync`: inference through a
returned function's `AsyncResult` is exactly where a principal silently widens
to `unknown`, and stating it once is what makes a mismatch a compile error at
step 4 instead of an `unknown` reaching a handler. It also means the
authenticator and the controllers cannot disagree — both come from the same
`httpAuth` call.

`Unauthenticated` carries **nothing**: the starter surfaces no reason — a
rejected caller gets an `UNAUTHORIZED` and oRPC's default message — so a payload
would be write-only. An authenticator that wants to record why logs it before
returning, which is one more argument for naming a logger in `deps`.

## Step 3 — read the principal

A marked procedure's handler receives the principal on **oRPC's own context
channel**, `opts.context.principal`. No second parameter, no wrapper.
`HttpController` is imported from the application's own `auth.ts`, so
`context.principal` is the `Identity` — `userId` and `tenantId` both, neither
of which the contract names:

```ts
import { HttpController } from "../../auth.js";

export const ordersController = HttpController(
  "OrdersController",
  contract.orders,
)([PlaceOrder, FindOrder, Logger], {
  sync: (place, find, logger) => ({
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
  }),
});
```

An **unmarked** procedure's `context` has no `principal`, so reading one there
is a compile error — and a controller whose handler reads `context.principal`
cannot be mounted under an unmarked contract key, where nothing would inject
one. The reverse is fine: an unmarked controller under a marked key is a
handler that ignores its caller's identity.

## Step 4 — pass it to `HttpModule`

The authenticator sits at the **root**, not in a slice: who a caller is is one
answer per process.

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  authenticator: bearerAuthenticator,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

Two things are checked here, and they are different gates:

- **Omitting the line** is di's own `UNSATISFIED DEPENDENCIES` at `start`. When
  the contract marks anything, `HttpRouter` appends `AuthenticatorPort` to the
  router provider's dependencies, so the need is real and unmet — no new gate,
  and nothing this package invents.
- **Supplying one minted on a different identity** is a compile error at
  the `HttpModule(...)` call itself. di cannot see it — `AuthenticatorPort`'s
  service type is erased to `unknown`, so any authenticator discharges the need
  — so `HttpModule` compares the **router's** identity against the
  **authenticator's**, both of which came from the same `httpAuth` call in an
  application that has one. The direction is
  `AuthIdentity extends RouterIdentity`: the authenticator must resolve at
  least what the handlers read, so a subtype discharges it.

A router minted by the package's own top-level `HttpRouter` carries no identity
and accepts any authenticator, including none: a provider nothing needs is di's
business and not an error to invent.

## What a rejected caller gets

| Situation                                      | Answer                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| the authenticator returns `Unauthenticated`    | `401 UNAUTHORIZED`, the handler never entered         |
| the authenticator defects                      | oRPC's `INTERNAL_SERVER_ERROR` collapse — not a `401` |
| a marked route with no authenticator behind it | `401` — the starter's fail-closed fallback            |
| an unmarked procedure, no credentials          | served                                                |

A defect is a bug in the authenticator, not a rejected caller, and reporting it
as one would tell an operator the opposite of what happened. The third row is
unreachable while the types and the runtime walk agree — which is exactly why
it is there.

On the client, `UNAUTHORIZED` is an error the contract does **not** declare, so
it is not inferable: it lands in `defect`, not in `errCases`. A client for a
marked fragment sends its credentials up front:

```ts
const client = createOrderApiClient("http://127.0.0.1:3000", "/rpc", {
  authorization: `Bearer ${tenantId}:${userId}`,
});
```

## The marker is legibility, not enforcement

**An unmarked procedure is public, and nothing fails if the marker is
forgotten.** There is no deny-by-default: a new procedure added to an unmarked
record is served to anyone, no compile error, no startup failure, no warning.
What the contract buys is that a protected route is _visible_ — one word in the
artifact both sides read, in the diff, in the generated types, and in the
handler's own signature.

So the marker is a declaration, not a policy. If you need deny-by-default, it
is the contract's job to say so — mark the root and unmark what is public —
and today that is something an application writes, not something this package
offers.

Two further non-goals worth stating plainly: the marker does not
**authenticate** (that is your `Authenticator`, and what a token means is
yours), and it does not model **authorization** — it says who a caller is, and
nothing about what they may do. Per-procedure permissions belong in the
handler, where the use case is.

## See also

- [`@btravstack/contract`](/reference/contract) — `authenticated`,
  `Authenticated`, `PrincipalKey`, `IsMarked`, `isAuthenticated`.
- [`@btravstack/http`](/reference/http) — `HttpAuthenticator`,
  `AuthenticatorPort`, `Unauthenticated`, and the request table.
- [Split a router into controllers](/how-to/split-a-router-into-controllers) —
  where the handler in step 3 lives once an API has slices.
- [Order API (HTTP)](/examples/order-api) — one marked fragment, one public
  one, end to end.
