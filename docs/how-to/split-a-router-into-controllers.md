---
title: Split a router into controllers
description: Give each slice of a large API its own contract fragment and controller, and compose them into one router at the root.
---

# Split a router into controllers

> **How-to.** For an API that has outgrown one `sync`. For the shape of a
> single-slice router, see [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http).

`HttpRouter(contract)(deps, { sync })` puts every procedure's implementation in
one function. That is right for a small API and wrong for a large one: a
fifty-procedure contract would mean fifty injected services in one `sync`, one
slice's typo failing the whole router's type-check, and no way to serve one
slice without the rest. A **controller** is the fix: an ordinary di provider
over one fragment of the contract, minted its own port, composed by the root
through a keyed `HttpRouter(contract)(controllers)` call. Everything below is
lifted from `examples/order-api`, which serves an `orders` slice and a
`customers` slice this way.

## Step 1 — a fragment per slice

A slice's contract is a plain `RouterContract` — the same shape the
positional form already takes, just smaller — and the root contract is a
record of them:

```ts
export const ordersContract = {
  place: oc
    .input(type<{ readonly id: string; readonly quantity: number }>())
    .output(type<OrderView>())
    .errors({
      INVALID_QUANTITY: { data: type<OrderRef>() },
      CONFLICT: { data: type<OrderRef>() },
    }),
  find: oc
    .input(type<OrderRef>())
    .output(type<OrderView>())
    .errors({ NOT_FOUND: { data: type<OrderRef>() } }),
};

export const customersContract = {
  find: oc
    .input(type<{ readonly id: string }>())
    .output(type<CustomerView>())
    .errors({ NOT_FOUND: { data: type<{ readonly id: string }>() } }),
};

export const orderContract = {
  orders: ordersContract,
  customers: customersContract,
};
```

## Step 2 — a controller per slice

`HttpController(name, fragment)([deps], { sync })` is `HttpRouter`'s own
shape, aimed at one fragment: the first call fixes the fragment's type and
mints a port under `name`; the second is di's `Provider(port)(deps, { sync })`,
so `sync`'s return is typed by the fragment at the call — a typo'd or missing
procedure is a compile error inside the controller itself, not at the root:

```ts
export const ordersController = HttpController(
  "OrdersController",
  ordersContract,
)([PlaceOrder, FindOrder], {
  sync: (place, find) => ({
    place: ({ errors }, input) =>
      place
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
            .with(P.tag("DuplicateOrder"), (error) =>
              errors.CONFLICT({
                message: error.message,
                data: { id: error.id },
              }),
            ),
        ),
    find: ({ errors }, input) =>
      find
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
  }),
});
```

The controller does no oRPC work of its own — it stores a plain record, and
`HttpRouter` wraps each leaf in `.result(...)` when it composes the router.
`ordersController.port` is the port class the keyed form reads to order this
controller's construction before the router's — there is nothing to name by
hand. A slice ships its controller as a module that exports only that port,
the same privacy di already gives any provider:

```ts
export const OrdersSlice = Module("OrdersSlice")({
  provides: [ordersController],
  exports: [ordersController.port],
});
```

## Step 3 — the keyed root

`HttpRouter(contract)(controllers)` — a record keyed by the contract's own
top-level keys, one `HttpController` per key — replaces the positional
`(deps, { sync })` call at the root:

```ts
export const orderRouter = HttpRouter(orderContract)({
  orders: ordersController,
  customers: customersController,
});
```

The composition root then imports each slice's module next to the transport
starter, exactly as it would import any other module:

```ts
export const OrderApi = HttpModule("OrderApi")({
  router: orderRouter,
  imports: [
    ApplicationModule,
    PersistenceModule,
    OrdersSlice,
    CustomersSlice,
    observability(),
  ],
  exports: [Logger],
});
```

This form is **exact**: a key the record above is missing, a key the
contract does not declare, and a controller wired under the wrong key are all
compile errors at the `HttpRouter(orderContract)({...})` call, not runtime
surprises the first time a client hits the missing slice.

## Step 4 — lifting a slice into its own process

Because a fragment is itself a valid `RouterContract`, a slice can be served
**alone** — and none of the files above change. The lifted root declares the
controller's own port as its single dependency and hands back what that
controller built:

```ts
export const ordersRouter = HttpRouter(ordersContract)(
  [ordersController.port],
  {
    sync: (implementation) => implementation,
  },
);

export const OrdersApi = HttpModule("OrdersApi")({
  router: ordersRouter,
  imports: [ApplicationModule, PersistenceModule, OrdersSlice],
});
```

`OrdersSlice` is the very module the modulith imported and `ordersController`
the very provider it composed — not a copy, not a rewritten `sync`. Extraction
is a new composition root and one fewer import, and the slice itself is
untouched. `packages/http/src/controller.test-d.ts` pins that call as its
fifth gate: the property is marked do-not-break, and it is what makes
composing slices into one router a starting point rather than a trap.

## See also

- [Serve an oRPC contract over HTTP](/how-to/serve-orpc-over-http) — the
  positional form, and everything the starter itself decides.
- [`@btravstack/http`](/reference/http) — `HttpController` and
  `HttpRouter`'s full signatures.
- [Order API (HTTP)](/examples/order-api) — the two-slice example these
  samples come from.
