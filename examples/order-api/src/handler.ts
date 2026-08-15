import type { IncomingMessage, ServerResponse } from "node:http";

import type { Runtime } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { httpRuntime, type HttpInfo, type HttpOptions } from "@btravstack/http";
import { getRequestListener } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";
import { fromSafePromise, type AsyncResult } from "unthrown";

import { OrderRouter, orderRouter } from "./router.js";

export const PREFIX = "/rpc" as const;

/**
 * The HTTP surface as a service: the node pair `@btravstack/http` hands over,
 * answered. The handler flushes the response before its `AsyncResult` settles,
 * which is the one obligation the runtime's unit-per-request design needs from
 * it.
 */
export class ApiHandler extends Port("ApiHandler")<
  (request: IncomingMessage, response: ServerResponse) => AsyncResult<unknown, never>
> {}

/**
 * The transport wiring lives in the graph, not at module scope: the router is
 * a provider that declares the two use cases its procedures call, and the Hono
 * app with oRPC's fetch adapter is a provider that declares the router — so
 * they exist because the composition root said so, and di's own arity gate
 * sees the transport's real dependencies. Nothing about the HTTP surface is a
 * free-floating singleton or a service located from a context at call time:
 * one container, and oRPC's own context is left empty.
 *
 * Hono owns routing and the fetch idiom; oRPC's fetch adapter is mounted under
 * `PREFIX`. An unmatched path falls through to Hono's 404; a defect inside a
 * procedure is oRPC's own `INTERNAL_SERVER_ERROR` collapse. `getRequestListener`
 * bridges the node pair the runtime hands over onto `app.fetch` — with
 * `overrideGlobalObjects` off, because its default swaps
 * `globalThis.Request`/`Response` for Hono's own on the first request served,
 * a process-wide side effect no composition root should get by surprise.
 */
export const ApiModule = Module("Api")({
  provides: [
    orderRouter,
    Provider(ApiHandler)([OrderRouter], {
      sync: (router) => {
        const rpc = new RPCHandler(router);

        const app = new Hono();
        app.all(`${PREFIX}/*`, async (c, next) => {
          const { matched, response } = await rpc.handle(c.req.raw, { prefix: PREFIX });
          if (matched) return response;
          return next();
        });

        const listener = getRequestListener((raw) => app.fetch(raw), {
          overrideGlobalObjects: false,
        });
        return (request, response) => fromSafePromise(listener(request, response));
      },
    }),
  ],
  exports: [ApiHandler],
});

/**
 * The runtime, needing exactly the port that IS the HTTP surface. That single
 * need is what makes `start`'s arity gate mean something — a module that does
 * not export `ApiHandler` fails to compile at the `runMain(...)` call, before
 * anything runs — and it is the whole of the transport wiring at every call
 * site, so `main.ts`, the specs and the type test cannot drift apart.
 */
export const apiRuntime = (
  options: Pick<HttpOptions<typeof ApiHandler>, "port" | "hostname">,
): Runtime<typeof ApiHandler, HttpInfo> =>
  httpRuntime({
    ...options,
    needs: [ApiHandler],
    handler: (request, response, ctx) => ctx.get(ApiHandler)(request, response),
  });
