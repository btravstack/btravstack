import type { IncomingMessage } from "node:http";

import { createOrderApiClient } from "@btravstack/example-order-api-client";
import type { OrderRef, OrderView } from "@btravstack/example-order-api-contract";
import { ORPCError } from "@orpc/client";
import SchemaBuilder from "@pothos/core";
import { createGraphQLError } from "graphql-yoga";
import { z } from "zod";

type Context = {
  readonly incoming: IncomingMessage;
  readonly unit: { readonly origin: { readonly url: string } };
};

const builder = new SchemaBuilder<{ Context: Context }>({});
const OrderRef = builder.objectRef<OrderView>("Order");
OrderRef.implement({
  fields: (t) => ({
    id: t.exposeString("id"),
    quantity: t.exposeInt("quantity"),
  }),
});

const clientOf = ({ incoming, unit }: Context) =>
  createOrderApiClient(
    unit.origin.url,
    "/rpc",
    incoming.headers.authorization ? { authorization: incoming.headers.authorization } : {},
  );

const backendDefect = (cause: unknown): never => {
  if (cause instanceof ORPCError && ["UNAUTHORIZED", "FORBIDDEN"].includes(cause.code)) {
    // oxlint-disable-next-line unthrown/no-throw -- GraphQL's resolver boundary reports authentication errors in its envelope
    throw createGraphQLError(cause.message, { extensions: { code: cause.code } });
  }
  // oxlint-disable-next-line unthrown/no-throw -- GraphQL masks unknown backend defects
  throw cause;
};

const orderId = (input: string): OrderRef["id"] => {
  const parsed = z.uuidv7().safeParse(input);
  if (!parsed.success) {
    // oxlint-disable-next-line unthrown/no-throw -- GraphQL's resolver boundary reports validation errors in its error envelope
    throw createGraphQLError("Invalid order ID", { extensions: { code: "BAD_REQUEST" } });
  }
  return parsed.data as OrderRef["id"];
};

builder.queryType({
  fields: (t) => ({
    order: t.field({
      type: OrderRef,
      nullable: true,
      args: { id: t.arg.string({ required: true }) },
      resolve: async (_parent, { id }, context) => {
        const found = await clientOf(context).orders.find({ id: orderId(id) });
        if (found.isDefect()) {
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's resolver boundary reports defects
          return backendDefect(found.cause);
        }
        if (found.isErr()) {
          if (found.error.code === "NOT_FOUND") return null;
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's error envelope is the transport result channel
          throw createGraphQLError(found.error.message, {
            extensions: { code: found.error.code },
          });
        }
        return found.value;
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
      resolve: async (_parent, { id, quantity }, context) => {
        const placed = await clientOf(context).orders.place({ id: orderId(id), quantity });
        if (placed.isDefect()) {
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's resolver boundary reports defects
          return backendDefect(placed.cause);
        }
        if (placed.isErr()) {
          // oxlint-disable-next-line unthrown/no-throw -- GraphQL's error envelope is the transport result channel
          throw createGraphQLError(placed.error.message, {
            extensions: { code: placed.error.code },
          });
        }
        return placed.value;
      },
    }),
  }),
});

/** Code-first source; `order-graphql-contract/schema.graphql` is its wire shape. */
export const orderGraphqlSchema = builder.toSchema();
