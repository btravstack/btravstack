import type { IncomingMessage, ServerResponse } from "node:http";

import type { Context } from "@btravstack/di";
import type { FindOrder, Logger, PlaceOrder } from "@btravstack/example-order-application";
import { RPCHandler } from "@orpc/server/node";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { orderRouter, type ApiContext } from "./router.js";

/**
 * The ports this handler resolves out of the context it is handed. Non-empty
 * on purpose: it is what makes `start`'s arity gate mean something — a module
 * that does not export all three fails to compile at the `start(...)` call,
 * before anything runs. `Logger` is not read here directly; the per-request
 * `RequestModule` (see `StartOptions.unit` in `main.ts`) needs it, and a fork
 * can only reach what the parent context carries.
 */
export type ApiNeeds = typeof PlaceOrder | typeof FindOrder | typeof Logger;

export const PREFIX = "/rpc" as const;

const handler = new RPCHandler(orderRouter);

/**
 * The context arriving here is already the request's own: `main.ts` passes
 * `RequestModule` as `StartOptions.unit`, so the kernel forks a scope around
 * every unit and this handler never manages one — it routes.
 *
 * The response is flushed inside this callback because `@btravstack/http`
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
  fromSafePromise(
    handler.handle(request, response, {
      prefix: PREFIX,
      context: { scope: ctx } satisfies ApiContext,
    }),
  );
