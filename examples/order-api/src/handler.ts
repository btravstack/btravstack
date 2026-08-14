import type { IncomingMessage, ServerResponse } from "node:http";

import { Module, Port, Provider, type Context } from "@btravstack/di";
import type { FindOrder, PlaceOrder } from "@btravstack/example-order-application";
import { getRequestListener } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { orderRouter, type ApiContext } from "./router.js";

export const PREFIX = "/rpc" as const;

/**
 * The HTTP surface as a service: `(request, response, scope)` — the node pair
 * `@btravstack/http` hands over, plus the request's own di `Context`, already
 * forked by the kernel (`StartOptions.unit`). The handler flushes the response
 * before its `AsyncResult` settles, which is the one obligation the runtime's
 * unit-per-request design needs from it.
 */
export class ApiHandler extends Port("ApiHandler")<
  (
    request: IncomingMessage,
    response: ServerResponse,
    scope: Context<PlaceOrder | FindOrder>,
  ) => AsyncResult<unknown, never>
> {}

/**
 * What the runtime resolves out of the request context: the HTTP surface
 * itself, plus the use cases its procedures read. Non-empty on purpose: it is
 * what makes `start`'s arity gate mean something — a module that does not
 * export all three fails to compile at the `runMain(...)` call, before
 * anything runs.
 */
export type ApiNeeds = typeof ApiHandler | typeof PlaceOrder | typeof FindOrder;

/**
 * The transport wiring lives in the graph, not at module scope: the Hono app
 * and the oRPC handler are built by a provider, so they exist because the
 * composition root said so, ordered with everything else the graph constructs
 * — nothing about the HTTP surface is a free-floating singleton.
 *
 * Hono owns routing and the fetch idiom; oRPC's fetch adapter is mounted
 * under `PREFIX`, handed the request's scope through Hono's `Bindings` — so
 * every procedure reads its use cases out of the request's own di context. An
 * unmatched path falls through to Hono's 404; a defect inside a procedure is
 * oRPC's own `INTERNAL_SERVER_ERROR` collapse. `getRequestListener` bridges
 * the node pair the runtime hands over onto `app.fetch`, per request, because
 * the scope it must carry is per-request too.
 */
export const ApiModule = Module("Api")({
  provides: [
    Provider(ApiHandler)({
      sync: () => {
        const rpc = new RPCHandler(orderRouter);

        const app = new Hono<{ Bindings: ApiContext }>();
        app.all(`${PREFIX}/*`, async (c, next) => {
          const { matched, response } = await rpc.handle(c.req.raw, {
            prefix: PREFIX,
            context: c.env,
          });
          if (matched) return response;
          return next();
        });

        return (request, response, scope) =>
          fromSafePromise(
            getRequestListener((raw) => app.fetch(raw, { scope } satisfies ApiContext))(
              request,
              response,
            ),
          );
      },
    }),
  ],
  exports: [ApiHandler],
});
