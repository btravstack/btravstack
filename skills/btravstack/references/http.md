# An HTTP capability, end to end

One procedure that can be refused, implemented in a slice and composed into a
root. The files are shown in the order you write them, each with the imports
it needs; in a real project the contract lives in its own package. Every fence
on this page is compiled against the framework.

## The use case

A port whose method answers an `AsyncResult` over concrete errors. The adapter
behind it is a provider like any other.

**`src/orders.ts`**

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync, TaggedError, type AsyncResult } from "unthrown";

export class InvalidQuantity extends TaggedError("InvalidQuantity")<{
  readonly quantity: number;
}> {
  override message = `quantity must be positive, got ${this.quantity}`;
}

export class DuplicateOrder extends TaggedError("DuplicateOrder")<{
  readonly id: string;
}> {
  override message = `order ${this.id} already exists`;
}

export type Order = { readonly id: string; readonly quantity: number };

export class PlaceOrder extends Port("PlaceOrder")<{
  readonly execute: (
    id: string,
    quantity: number,
  ) => AsyncResult<Order, InvalidQuantity | DuplicateOrder>;
}> {}

export const OrdersModule = Module("Orders")({
  provides: [
    Provider(PlaceOrder)({
      inject: {},
      sync: () => {
        const placed = new Set<string>();
        return {
          execute: (id, quantity) => {
            if (quantity <= 0) return ErrAsync(new InvalidQuantity({ quantity }));
            if (placed.has(id)) return ErrAsync(new DuplicateOrder({ id }));
            placed.add(id);
            return OkAsync({ id, quantity });
          },
        };
      },
    }),
  ],
  exports: [PlaceOrder],
});
```

## The contract

Each refusal a caller must handle is named in `.errors`, with the data it
carries. A fragment such as `orders` is itself a valid contract.

**`src/contract.ts`**

```ts
import { oc } from "@orpc/contract";
import { z } from "zod";

const orderRef = z.object({ id: z.string() });

export const contract = {
  orders: {
    place: oc
      .input(z.object({ id: z.string(), quantity: z.number() }))
      .output(z.object({ id: z.string(), quantity: z.number() }))
      .errors({
        INVALID_QUANTITY: { data: z.object({ quantity: z.number() }) },
        CONFLICT: { data: orderRef },
      }),
  },
};
```

## The controller: the one triage point

`api.OrpcController(contract, path)` types the leaves by that fragment. The
leaf maps every case of the use case's error union to a contract error, and
the matcher has no wildcard, so a new domain error fails to compile here.

**`src/orders-controller.ts`**

```ts
import { defineHttp } from "@btravstack/orpc-server";
import { P } from "unthrown";
import { contract } from "./contract.js";
import { PlaceOrder } from "./orders.js";

export const api = defineHttp();

export const ordersController = api.OrpcController(
  contract,
  "orders",
)({
  inject: { placeOrder: PlaceOrder },
  sync: ({ placeOrder }) => ({
    place: ({ errors }, input) =>
      placeOrder.execute(input.id, input.quantity).mapErrCases((matcher) =>
        matcher
          .with(P.tag("InvalidQuantity"), (error) =>
            errors.INVALID_QUANTITY({
              message: error.message,
              data: { quantity: error.quantity },
            }),
          )
          .with(P.tag("DuplicateOrder"), (error) =>
            errors.CONFLICT({ message: error.message, data: { id: error.id } }),
          ),
      ),
  }),
});
```

`defineHttp` is called once per application, takes the security schemes when
there are any, and is held whole.

## The slice and the root

The slice provides and exports its piece and imports the vertical it owns. The
root composes every piece in one array, which must cover the contract exactly,
and imports every slice.

**`src/module.ts`**

```ts
import { Module } from "@btravstack/di";
import { HttpModule } from "@btravstack/orpc-server";
import { contract } from "./contract.js";
import { api, ordersController } from "./orders-controller.js";
import { OrdersModule } from "./orders.js";

export const OrdersSlice = Module("OrdersSlice")({
  imports: [OrdersModule],
  provides: [ordersController],
  exports: [ordersController],
});

export const App = HttpModule("App")({
  router: api.OrpcRouter(contract)([ordersController]),
  imports: [OrdersSlice],
});
```

`main.ts` is `await runMain(App)` from `@btravstack/core`. The procedure is
served at `POST /rpc/orders/place`.

## Going further

- Authentication: mark a procedure with `authenticated({ user: [] })` from
  `@btravstack/contract` and pass the scheme to `defineHttp`
  (<https://btravstack.github.io/btravstack/how-to/protect-a-procedure>).
- Per-request services and the tenant: the `unit` record on a controller
  (<https://btravstack.github.io/btravstack/how-to/use-request-scoped-services>).
- OpenAPI routes and a status per error
  (<https://btravstack.github.io/btravstack/how-to/serve-an-openapi-contract>).
- Lifting a slice into its own deployment
  (<https://btravstack.github.io/btravstack/how-to/split-a-router-into-controllers>).
