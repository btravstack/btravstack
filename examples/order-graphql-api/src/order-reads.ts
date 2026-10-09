import { Port, Provider } from "@btravstack/di";
import { createOrderApiClient, type OrderApiClient } from "@btravstack/example-order-api-client";
import type { OrderRef, OrderView } from "@btravstack/example-order-api-contract";
import { ORPCError } from "@orpc/client";
import DataLoader from "dataloader";
import type { GraphQLError } from "graphql";
import { createGraphQLError } from "graphql-yoga";
import { Err, Ok, fromSafePromise, type AsyncResult, type Result } from "unthrown";

/** Where the order API answers — `ORDER_API_URL`. */
export class OrderApiOrigin extends Port("OrderApiOrigin")<{ readonly url: string }> {}

/** One caller's view of the order API for the length of one request. */
export type CallerReads = {
  readonly client: OrderApiClient;
  /** `orders.find`, cached for the request: an id is fetched once however many fields ask for it. */
  readonly find: (id: OrderRef["id"]) => AsyncResult<OrderView | null, GraphQLError>;
  /** A write, told to the cache: the next read of that order answers it without a call. */
  readonly wrote: (order: OrderView) => void;
};

/**
 * The request's order reads. Unit-scoped, so the cache lives exactly as long as
 * the request it belongs to; the caller's credentials arrive with the first
 * read, since a request carries one.
 */
export class OrderReads extends Port("OrderReads")<{
  readonly forCaller: (authorization: string | undefined) => CallerReads;
}> {}

/**
 * The order API's own authentication refusal, which its client reports as a
 * defect — it is no error the contract declares — as this field's refusal.
 * Anything else stays a defect, for `fieldResult` to mask.
 */
export const refusedByService = (cause: unknown): Result<never, GraphQLError> => {
  if (cause instanceof ORPCError && (cause.code === "UNAUTHORIZED" || cause.code === "FORBIDDEN"))
    return Err(createGraphQLError(cause.message, { extensions: { code: cause.code } }));
  // oxlint-disable-next-line unthrown/no-throw -- recoverDefect keeps a rethrown cause a defect
  throw cause;
};

/** A refusal the contract declares, as this field's error. */
export const refusal = (error: { readonly code: string; readonly message: string }) =>
  createGraphQLError(error.message, { extensions: { code: error.code } });

const callerReads = (client: OrderApiClient): CallerReads => {
  const found = new DataLoader<OrderRef["id"], Result<OrderView | null, GraphQLError>>((ids) =>
    Promise.all(
      ids.map((id) =>
        client.orders
          .find({ id })
          .flatMapErrCases((matcher) => matcher.with({ code: "NOT_FOUND" }, () => Ok(null)))
          .recoverDefect(refusedByService),
      ),
    ),
  );
  return {
    client,
    find: (id) => fromSafePromise(found.load(id)).flatMap((result) => result),
    wrote: (order) => void found.clear(order.id).prime(order.id, Ok(order)),
  };
};

export const orderReads = Provider(OrderReads)({
  inject: { origin: OrderApiOrigin },
  sync: ({ origin }) => {
    let reads: CallerReads | undefined;
    return {
      forCaller: (authorization) =>
        (reads ??= callerReads(
          createOrderApiClient(origin.url, "/rpc", authorization ? { authorization } : {}),
        )),
    };
  },
});
