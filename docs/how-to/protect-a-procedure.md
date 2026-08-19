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
`context.principal` typed with what the contract declared.

## Recipe

1. Declare the principal and mark the contract with
   `auth<Principal>()`'s `authenticated`.
2. Write the authenticator with `HttpAuthenticator<Principal>()([deps], { sync })`
   — headers in, `AsyncResult<Principal, Unauthenticated>` out.
3. Read `opts.context.principal` in the handlers of the marked procedures.
4. Pass the provider as `HttpModule(name)({ router, authenticator })`.

## Step 1 — mark the contract

The marker goes in the contract package, because it is a fact about the API
that a client should be able to read without taking the server:

```ts
import { auth } from "@btravstack/contract";
import { oc, type } from "@orpc/contract";

/** Who the caller is, as this API models it. */
export type Principal = { readonly userId: string; readonly tenantId: string };

const { authenticated } = auth<Principal>();

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

## Step 2 — write the authenticator

`HttpAuthenticator<P>()([deps], { sync })` is an ordinary di provider on the
starter's `AuthenticatorPort`. It resolves a principal from the request's
**headers** — not the request: an authenticator has no business reading a
body, and the narrower argument is what keeps it testable without a socket.

```ts
import type { Principal } from "./contract.js";
import { HttpAuthenticator, Unauthenticated } from "@btravstack/http";
import { ErrAsync, OkAsync } from "unthrown";

export const bearerAuthenticator = HttpAuthenticator<Principal>()([], {
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
      ? ErrAsync(new Unauthenticated({ reason: "no usable bearer token" }))
      : OkAsync({ tenantId, userId });
  },
});
```

`Bearer <tenantId>:<userId>` is a stand-in, not a recommendation — what
matters is the shape. `[]` because this one needs no service; a JWT verifier, a
key set or a user directory is named there and injected the way any provider's
dependencies are, so swapping the stand-in for real verification changes
nothing else in the composition.

The type argument is **explicit** rather than inferred from `sync`: inference
through a returned function's `AsyncResult` is exactly where a principal
silently widens to `unknown`, and stating it is what makes a mismatch a compile
error at step 4 instead of an `unknown` reaching a handler.

`Unauthenticated` carries a `reason`, and the reason is **yours**: the starter
does not surface it. A rejected caller gets an `UNAUTHORIZED` carrying oRPC's
default message and nothing derived from the refusal — so an authenticator that
wants the reason recorded logs it itself, which is one more argument for naming
a logger in `deps`.

## Step 3 — read the principal

A marked procedure's handler receives the principal on **oRPC's own context
channel**, `opts.context.principal`, typed with what the contract declared. No
second parameter, no wrapper:

```ts
export const ordersController = HttpController(
  "OrdersController",
  contract.orders,
)([PlaceOrder, FindOrder], {
  sync: (place, find) => ({
    place: ({ errors, context }, input) =>
      place
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
        ),
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
- **Supplying one that resolves a different principal** is a compile error at
  the `HttpModule(...)` call itself. di cannot see it — `AuthenticatorPort`'s
  service type is erased to `unknown`, so any authenticator discharges the need
  — so `HttpModule` checks the principal against the router's own.

An **unmarked** router accepts any authenticator, including none: a provider
nothing needs is di's business and not an error to invent.

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

- [`@btravstack/contract`](/reference/contract) — `auth`, `Authenticated`,
  `PrincipalKey`, `PrincipalOf`, `isAuthenticated`.
- [`@btravstack/http`](/reference/http) — `HttpAuthenticator`,
  `AuthenticatorPort`, `Unauthenticated`, and the request table.
- [Split a router into controllers](/how-to/split-a-router-into-controllers) —
  where the handler in step 3 lives once an API has slices.
- [Order API (HTTP)](/examples/order-api) — one marked fragment, one public
  one, end to end.
