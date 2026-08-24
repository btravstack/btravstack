---
title: Split a router into controllers
description: Give each slice of a large API its own contract fragment and controller, and compose them into one router at the root.
---

<!-- doctest: prelude
import { Module } from "@btravstack/di";
import { HttpModule } from "@btravstack/http";
import { Logger, observability } from "@btravstack/observability";
import { P } from "unthrown";
import type { Order } from "@btravstack/example-order-domain";
import { FindOrder, OrderApplicationModule, PlaceOrder } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { api } from "../../auth.js";
import { customersController } from "../../slices/customers/controller.js";
import { CustomersSlice } from "../../slices/customers/module.js";
declare const view: (order: Order) => { id: string; quantity: number };
-->

# Split a router into controllers

> **How-to.** The lesson that fronts this recipe:
> [Split into slices](/tutorial/split-into-slices).
> For an API that has outgrown one `sync`. For the shape of a
> single-slice router, see [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http).

`api.HttpRouter(contract)(deps, { sync })` puts every procedure's implementation in
one function. That is right for a small API and wrong for a large one: a
fifty-procedure contract would mean fifty injected services in one `sync`, one
slice's typo failing the whole router's type-check, and no way to serve one
slice without the rest. A **controller** is the fix: an ordinary di provider
over one fragment of the contract, minted its own port from the contract key,
composed by the root through
`api.HttpRouter(contract)([controller, …])`. It is the same authoring flow
[a worker slice](/how-to/split-a-worker-into-slices) uses — mint a piece from
a contract key, compose an array — and not HTTP's own. Everything below is
lifted from `examples/order-api`, which serves an `orders` slice and a
`customers` slice this way.

## Step 1 — a fragment per slice

A slice's contract is a plain `RouterContract` — the same shape the
whole-contract form already takes, just smaller — and the root contract is a
record of them:

```ts
import { authenticated } from "@btravstack/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderView = z.object({ id: z.uuidv7(), quantity: z.number() });
export type OrderView = z.infer<typeof orderView>;

const orderRef = z.object({ id: z.uuidv7() });
export type OrderRef = z.infer<typeof orderRef>;

// `BAD_REQUEST` names the id **as received**, which is the one value that is
// not a UUIDv7: `orderRef` would reject the only payload it ever carries.
const malformedRef = z.object({ id: z.string() });

const customerView = z.object({ id: z.uuidv7(), name: z.string() });
export type CustomerView = z.infer<typeof customerView>;

// The same shape as `orderRef` and deliberately its own schema: sharing that
// one would type a customer id as "which order it was about".
const customerRef = z.object({ id: z.uuidv7() });
export type CustomerRef = z.infer<typeof customerRef>;

const ordersContract = {
  place: oc
    .input(z.object({ id: z.uuidv7(), quantity: z.number() }))
    .output(orderView)
    .errors({
      INVALID_QUANTITY: { data: orderRef },
      BAD_REQUEST: { data: malformedRef },
      CONFLICT: { data: orderRef },
    }),
  find: oc
    .input(orderRef)
    .output(orderView)
    .errors({ NOT_FOUND: { data: orderRef } }),
};

const customersContract = {
  find: oc
    .input(z.object({ tenantId: z.uuidv7(), id: z.uuidv7() }))
    .output(customerView)
    .errors({ NOT_FOUND: { data: customerRef } }),
};

export const contract = {
  orders: authenticated({ user: [] })(ordersContract),
  customers: customersContract,
};
```

The fragments stay module-private; `contract` and the view types inferred from
its schemas are the only exports, and every consumer below reaches a fragment
through it — `contract.orders`, `contract.customers`. A schema is what a
fragment is made of, not a bare `type<T>()`: it validates what arrives at the
slice, and inferring the view type from it keeps the checked shape and the
compiled one from drifting apart.

The two fragments differ in one more way, and it is worth reading as part of
the split: `orders` is [`authenticated({ user: [] })`](/reference/contract) and names no
tenant on its inputs, because a caller's own identity establishes it; the
unmarked `customers` names one, because "which tenant" is then part of what is
being asked. A marker is per fragment, so slicing a contract is also where a
public half and a protected one stop being one undifferentiated surface.

## Step 2 — a controller per slice

`api.HttpController(contract, key)({ name: Dep }, { sync })` is
`api.HttpRouter`'s own
shape, aimed at one fragment: the first call names the fragment by its
contract key and mints a port from it, `` `HttpController:${key}` ``; the
second is di's `Provider(port)({ name: Dep }, { sync })`,
so `sync`'s return is typed by the fragment at the call — a typo'd or missing
procedure is a compile error inside the controller itself, not at the root.
There is no name to invent, and a key the contract does not declare is refused
here, where there is nothing to type it by:

```ts
import { api } from "../../auth.js";

export const ordersController = api.HttpController(contract, "orders")(
  { place: PlaceOrder, find: FindOrder },
  {
    sync: ({ place, find }) => ({
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
  },
);
```

`HttpController` comes off the application's own `api` in `auth.ts`, not from
`@btravstack/http` — there is no top-level one: the marker on the fragment says
which schemes protect the route, and
`defineHttp({ authenticators })` in that one file is what says what each scheme
resolves to, so
`context.principal` has a readable type here. Reached through any other
`defineHttp` call it would be `never`, and every read a compile error.
The unmarked `customers` controller is unaffected either way — its context has
no `principal` at all. See [Protect a procedure](/how-to/protect-a-procedure).

The controller does no oRPC work of its own — it stores a plain record, and
`api.HttpRouter` wraps each leaf in `.result(...)` when it composes the router.
`api.HttpController` mints the port and carries it back on `.port`, which the
composing form reads to order this controller's construction before the
router's — and whose id carries the contract key, so the root recovers it
without anybody spelling it twice. A slice ships its controller as a module
that **imports the vertical it needs** and exports only that controller, the
same privacy di already gives any provider:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  // The controller writes a line itself, so `Logger` is this slice's own
  // provider's need. The environment its persistence reads `DATABASE_URL` from
  // is not: that one is `DatabaseModule`'s, declared there and inherited
  // through the imports below.
  needs: [Logger],
  imports: [OrderApplicationModule, OrderPersistenceModule],
  provides: [ordersController],
  exports: [ordersController],
});
```

`exports` takes the provider itself, not `ordersController.port`: the port was
minted inside `HttpController`, so there is no class to spell back off it.
Importing the vertical here rather than leaving `PlaceOrder` and `FindOrder`
as needs for the root is what makes the slice a unit — the reason to open this
directory is the whole reason it exists. A vertical is a pair of modules of
its own — the customers slice imports `CustomerApplicationModule` and
`CustomerPersistenceModule` — so importing one slice's vertical brings none of
another's. Where slices do converge, on the internal database module both
persistence modules import, it is a diamond and not duplication: di flattens
the module tree into a `Set` keyed by provider **reference**, so one database
is built.

## Step 3 — the composed root

`api.HttpRouter(contract)([controller, …])` — an array of controllers, one per
top-level contract key — replaces the
`(deps, { sync })` call at the root. Nothing names a key here: each
controller's port id already carries the one it was minted from, and the call
strips the prefix back off to recover it. An array is never a record, so it is
told apart from the other two arms outright:

```ts
export const orderRouter = api.HttpRouter(contract)([
  ordersController,
  customersController,
]);
```

The composition root is then a list of **slices**, plus whatever no slice
owns:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [OrdersSlice, CustomersSlice, observability()],
  exports: [Logger],
});
```

`observability()` is here because every slice's layers write to its `Logger`
and none of them owns it; `Logger` is exported because the per-request module
reads it. The **authenticators are not** here, and that is the point: who a
caller is is one answer per process, so they were declared once in `auth.ts`
and they ride the router, which is what needs them — `HttpModule` puts them in
`provides` itself. A marked fragment makes each scheme it names a dependency of
the router provider, so a scheme with no authenticator behind it leaves
`HttpAuthenticator:<scheme>` in the root's
`Needs` and `start` refuses the module — not a gate of this package's, and not
di's arity gate either, but the plain assignability of the `Needs` channel
against `Env | Scope`, which names the port. Nothing else about what a slice
needs is spelled at the root.

This form is **exact** on coverage: a fragment no controller in the array
covers is a compile error at the `api.HttpRouter(contract)([...])` call —
refused against `"UNCOVERED CONTROLLERS — the contract declares a fragment
this array does not cover"` — not a runtime surprise the first time a client
hits the missing slice. The other two gates the keyed record used to carry
have moved somewhere better: a key the contract does not declare is refused at
the mint, and a controller under the wrong key is impossible, because the key
rides the port id rather than a position at the root.

Coverage is not uniqueness, though: two controllers minted for one fragment
type-check together fine, and di catches the conflict only when **both** are
discharged — then they are two providers for one port, its duplicate-provider
defect at build.

## Step 4 — lifting a slice into its own process

Because a fragment is itself a valid `RouterContract`, a slice can be served
**alone** — and none of the files above change. The lifted root declares the
controller's own port as its single dependency and hands back what that
controller built:

```ts
export const ordersRouter = api.HttpRouter(contract.orders)(
  { implementation: ordersController.port },
  { sync: ({ implementation }) => implementation },
);

export const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [OrdersSlice, observability()],
});
```

`api` here is `auth.ts`'s too — the lifted fragment carries its marker, so the
lifted root owes the same schemes the modulith did, and the router brings the
authenticators for them from that same call. Extraction adds no line about
identity at all.

`OrdersSlice` is the very module the modulith imported and `ordersController`
the very provider it composed — not a copy, not a rewritten `sync`. Extraction
is a new composition root and one fewer import, and the slice itself is
untouched. `packages/http/src/controller.test-d.ts` pins that call as its
fifth gate: the property is marked do-not-break, and it is what makes
composing slices into one router a starting point rather than a trap.

## See also

- [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) — the
  one-router form, and everything the starter itself decides.
- [`@btravstack/http`](/reference/http) — `defineHttp`, `HttpController` and
  `HttpRouter`'s full signatures.
- [Protect a procedure](/how-to/protect-a-procedure) — `auth.ts`, the
  authenticators, and what a marked fragment does to a controller.
- [Order API (HTTP)](/examples/order-api) — the two-slice example these
  samples come from.
