import type { IncomingMessage } from "node:http";

import { createOrderApiClient } from "@btravstack/example-order-api-client";
import type { OrderRef, OrderView } from "@btravstack/example-order-api-contract";
import { fieldResult } from "@btravstack/graphql-server";
import { ORPCError } from "@orpc/client";
import SchemaBuilder from "@pothos/core";
import type { GraphQLError } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import { Err, Ok, type Result } from "unthrown";
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

/**
 * The order API's own authentication refusal, which its client reports as a
 * defect — it is no error the contract declares — as this field's refusal.
 * Anything else stays a defect, for `fieldResult` to mask.
 */
const refusedByService = (cause: unknown): Result<never, GraphQLError> => {
  if (cause instanceof ORPCError && (cause.code === "UNAUTHORIZED" || cause.code === "FORBIDDEN"))
    return Err(createGraphQLError(cause.message, { extensions: { code: cause.code } }));
  // oxlint-disable-next-line unthrown/no-throw -- recoverDefect keeps a rethrown cause a defect
  throw cause;
};

const refusal = (error: { readonly code: string; readonly message: string }) =>
  createGraphQLError(error.message, { extensions: { code: error.code } });

const orderId = (input: string): Result<OrderRef["id"], GraphQLError> => {
  const parsed = z.uuidv7().safeParse(input);
  return parsed.success
    ? Ok(parsed.data as OrderRef["id"])
    : Err(createGraphQLError("Invalid order ID", { extensions: { code: "BAD_REQUEST" } }));
};

builder.queryType({
  fields: (t) => ({
    order: t.field({
      type: OrderRef,
      nullable: true,
      args: { id: t.arg.string({ required: true }) },
      resolve: (_parent, { id }, context) =>
        fieldResult(
          orderId(id)
            .toAsync()
            .flatMap((orderId) =>
              clientOf(context)
                .orders.find({ id: orderId })
                .flatMapErrCases((matcher) => matcher.with({ code: "NOT_FOUND" }, () => Ok(null)))
                .recoverDefect(refusedByService),
            ),
        ),
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
      resolve: (_parent, { id, quantity }, context) =>
        fieldResult(
          orderId(id)
            .toAsync()
            .flatMap((orderId) =>
              clientOf(context)
                .orders.place({ id: orderId, quantity })
                .mapErrCases((matcher) =>
                  matcher
                    .with({ code: "INVALID_QUANTITY" }, refusal)
                    .with({ code: "BAD_REQUEST" }, refusal)
                    .with({ code: "CONFLICT" }, refusal),
                )
                .recoverDefect(refusedByService),
            ),
        ),
    }),
  }),
});

/** Code-first source; `order-graphql-contract/schema.graphql` is its wire shape. */
export const orderGraphqlSchema = builder.toSchema();
