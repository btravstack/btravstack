import type { IncomingMessage, ServerResponse } from "node:http";

import { Module, type Context } from "@btravstack/di";
import type { FindOrder, Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { RPCHandler } from "@orpc/server/node";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { RequestModule } from "./request-scope.js";
import { orderRouter, type ApiContext } from "./router.js";

/**
 * The ports this handler resolves out of the application context. Non-empty on
 * purpose: it is what makes `start`'s arity gate mean something — a module that
 * does not export all three fails to compile at the `start(...)` call, before
 * anything runs. `Logger` is not read here directly; the per-request scope
 * forked below needs it, and a fork can only reach what the parent context
 * carries.
 */
export type ApiNeeds = typeof PlaceOrder | typeof FindOrder | typeof Logger;

export const PREFIX = "/rpc" as const;

const handler = new RPCHandler(orderRouter);

/**
 * The application scope belongs to the kernel and holds the database; this
 * layers a per-request scope over it, so a request-scoped provider is torn down
 * with the request and the parent's services are seeded, not rebuilt.
 *
 * The response is flushed inside this callback because `@btravstack/start-http`
 * keeps the unit open until the response completes — the obligation the kernel
 * cannot check is discharged by the package, not by this code being careful.
 * An unmatched or failing call is answered by the package itself (`404`/`500`),
 * so there is nothing left here to dispatch or end by hand.
 */
export const apiHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context<InstanceType<ApiNeeds>>,
): AsyncResult<unknown, never> =>
  Module.forkScope(ctx, RequestModule, (scope) =>
    fromSafePromise(
      handler.handle(request, response, {
        prefix: PREFIX,
        context: { scope } satisfies ApiContext,
      }),
    ),
  );
