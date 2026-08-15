import { Module, Provider } from "@btravstack/di";
import { HttpHandler } from "@btravstack/http";
import { getRequestListener } from "@hono/node-server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import { OrderRouter, orderRouter } from "./router.js";

export const PREFIX = "/rpc" as const;

/**
 * The transport wiring lives in the graph, not at module scope: the router is
 * a provider that declares the two use cases its procedures call, and the Hono
 * app with oRPC's fetch adapter is a provider of `@btravstack/http`'s own
 * `HttpHandler` port that declares the router — so they exist because the
 * composition root said so, and di's own arity gate sees the transport's real
 * dependencies. Nothing about the HTTP surface is a free-floating singleton or
 * a service located from a context at call time: one container, and oRPC's
 * own context is left empty. `HttpHandler` is the one port the runtime
 * `httpModule` provides needs, resolved out of each request's context; a
 * module that does not export it fails to compile at the `runMain(...)` call,
 * before anything runs.
 *
 * The handler flushes the response before its promise settles, which is the
 * one obligation the runtime's unit-per-request design needs from it.
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
    Provider(HttpHandler)([OrderRouter], {
      sync: (router) => {
        const rpc = new RPCHandler(router);

        const app = new Hono();
        app.all(`${PREFIX}/*`, async (c, next) => {
          const { matched, response } = await rpc.handle(c.req.raw, { prefix: PREFIX });
          if (matched) return response;
          return next();
        });

        return getRequestListener((raw) => app.fetch(raw), { overrideGlobalObjects: false });
      },
    }),
  ],
  exports: [HttpHandler],
});
