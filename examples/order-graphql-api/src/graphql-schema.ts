import type { ServiceOf } from "@btravstack/di";
import { contract, type OrderView } from "@btravstack/example-order-api-contract";
import { fieldResult, type GraphqlContext } from "@btravstack/graphql-server";
import SchemaBuilder from "@pothos/core";

import { inputOf } from "./contract-input.js";
import { refusal, refusedByService, type OrderReads } from "./order-reads.js";

type Context = GraphqlContext<undefined, { readonly reads: ServiceOf<OrderReads> }>;

const builder = new SchemaBuilder<{ Context: Context }>({});

const readsOf = ({ unit, incoming }: Context) =>
  unit.reads.forCaller(incoming.headers.authorization);

const OrderRef = builder.objectRef<OrderView>("Order");
OrderRef.implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    quantity: t.exposeInt("quantity"),
  }),
});

const Query = builder.queryType({
  fields: (t) => ({
    order: t.field({
      type: OrderRef,
      nullable: true,
      args: { id: t.arg.string({ required: true }) },
      resolve: (_parent, { id }, context) =>
        fieldResult(
          inputOf(contract.orders.find, { id }).flatMap((input) => readsOf(context).find(input.id)),
        ),
    }),
  }),
});

/**
 * What a placement answers: the order, and the whole `Query` read after the
 * write — in the same operation, from the same request's cache, which the
 * write has already updated.
 */
const PlaceOrderPayload = builder.objectRef<{ readonly order: OrderView }>("PlaceOrderPayload");
PlaceOrderPayload.implement({
  fields: (t) => ({
    order: t.field({ type: OrderRef, resolve: (payload) => payload.order }),
    query: t.field({ type: Query, resolve: () => ({}) }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    placeOrder: t.field({
      type: PlaceOrderPayload,
      args: {
        id: t.arg.string({ required: true }),
        quantity: t.arg.int({ required: true }),
      },
      resolve: (_parent, { id, quantity }, context) =>
        fieldResult(
          inputOf(contract.orders.place, { id, quantity }).flatMap((input) => {
            const reads = readsOf(context);
            return reads.client.orders
              .place(input)
              .mapErrCases((matcher) =>
                matcher
                  .with({ code: "INVALID_QUANTITY" }, refusal)
                  .with({ code: "BAD_REQUEST" }, refusal)
                  .with({ code: "CONFLICT" }, refusal),
              )
              .recoverDefect(refusedByService)
              .tap(reads.wrote)
              .map((order) => ({ order }));
          }),
        ),
    }),
  }),
});

/** Code-first source; `order-graphql-contract/schema.graphql` is its wire shape. */
export const orderGraphqlSchema = builder.toSchema();
