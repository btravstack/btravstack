import { Module } from "@btravstack/di";
import { HttpHandler } from "@btravstack/http";
import { orpc } from "@btravstack/orpc";

import { OrderRouter, orderRouter } from "./router.js";

/**
 * The HTTP surface as a module: the router is a provider that declares the two
 * use cases its procedures call, and `@btravstack/orpc`'s starter turns that
 * `OrderRouter` port into `@btravstack/http`'s `HttpHandler` — Hono, oRPC's
 * fetch adapter under `/rpc`, and the node bridge, none of it written here.
 * The transport wiring exists because the composition root said so, oRPC's own
 * context stays empty, and a module that does not export `HttpHandler` fails to
 * compile at the `runMain(...)` call, before anything runs.
 */
export const ApiModule = Module("Api")({
  provides: [orderRouter, orpc(OrderRouter)],
  exports: [HttpHandler],
});
