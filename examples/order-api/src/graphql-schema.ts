import type { ServiceOf } from "@btravstack/di";
import type { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import type { Order } from "@btravstack/example-order-domain";
import SchemaBuilder from "@pothos/core";
import { createGraphQLError } from "graphql-yoga";
import { P } from "unthrown";

type Context = {
  readonly unit: {
    readonly find: ServiceOf<InstanceType<typeof FindOrder>>;
    readonly place: ServiceOf<InstanceType<typeof PlaceOrder>>;
  };
};

const builder = new SchemaBuilder<{ Context: Context }>({});

const OrderRef = builder.objectRef<Order>("Order");
OrderRef.implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    quantity: t.exposeInt("quantity"),
  }),
});

builder.queryType({
  fields: (t) => ({
    order: t.field({
      type: OrderRef,
      nullable: true,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_parent, { id }, { unit }) => {
        const found = await unit.find
          .execute(id)
          .mapErrCases((matcher) => matcher.with(P.tag("OrderNotFound"), () => null));
        if (found.isDefect()) {
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's resolver boundary reports defects by throwing
          throw found.cause;
        }
        return found.isErr() ? null : found.value;
      },
    }),
  }),
});

builder.mutationType({
  fields: (t) => ({
    placeOrder: t.field({
      type: OrderRef,
      args: {
        id: t.arg.string({ required: true }),
        quantity: t.arg.int({ required: true }),
      },
      resolve: async (_parent, { id, quantity }, { unit }) => {
        const placed = await unit.place.execute(id, quantity).mapErrCases((matcher) =>
          matcher
            .with(P.tag("InvalidQuantity"), (error) =>
              createGraphQLError(error.message, { extensions: { code: "INVALID_QUANTITY" } }),
            )
            .with(P.tag("InvalidOrderId"), (error) =>
              createGraphQLError(error.message, { extensions: { code: "BAD_REQUEST" } }),
            )
            .with(P.tag("DuplicateOrder"), (error) =>
              createGraphQLError(error.message, { extensions: { code: "CONFLICT" } }),
            ),
        );
        if (placed.isDefect()) {
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's resolver boundary reports defects by throwing
          throw placed.cause;
        }
        if (placed.isErr()) {
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's error envelope is the transport's result channel
          throw placed.error;
        }
        return placed.value;
      },
    }),
  }),
});

/** Code-first source; `order-graphql-contract/schema.graphql` is its published wire shape. */
export const orderGraphqlSchema = builder.toSchema();
