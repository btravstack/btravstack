import { Port, Provider, type AnyPort, type PortInstance, type ServiceOf } from "@btravstack/di";
import { getRequestListener } from "@hono/node-server";
import type { Router } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import { HttpHandler } from "./handler.js";

export type OrpcOptions = {
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
};

/**
 * The oRPC starter: a provider of `@btravstack/http`'s `HttpHandler` built
 * from a **router port** — the application provides its router as a service
 * (a provider that declares the use cases its procedures call), and this
 * turns it into the HTTP surface. Hono owns routing and the fetch idiom;
 * oRPC's fetch adapter is mounted under `prefix`; an unmatched path is Hono's
 * 404 and a defect inside a procedure is oRPC's own `INTERNAL_SERVER_ERROR`
 * collapse. Nothing here maps a `Result` to a status — that is the router's
 * `.result()` triage, at the one place a domain error becomes an `ORPCError`.
 *
 * `getRequestListener` runs with `overrideGlobalObjects: false`: its default
 * swaps `globalThis.Request`/`Response` for Hono's own on the first request
 * served, a process-wide side effect no composition root should get by
 * surprise.
 */
/**
 * `unknown` when the port's service is a router `RPCHandler` can serve with no
 * initial context, `never` otherwise — intersected with `R` at the call site,
 * so a port whose service is not such a router fails to typecheck there rather
 * than at the first request. A router that declares an initial context is
 * rejected too: this starter has none to hand it.
 */
export type RouterPort<R extends AnyPort> =
  ServiceOf<R> extends Router<Record<never, never>> ? unknown : never;

export const orpc = <R extends AnyPort>(router: R & RouterPort<R>, options: OrpcOptions = {}) => {
  const prefix = options.prefix ?? "/rpc";
  return Provider(HttpHandler)([router], {
    sync: (service) => {
      const rpc = new RPCHandler(service as Router<Record<never, never>>);
      const app = new Hono();
      app.all(`${prefix}/*`, async (c, next) => {
        const { matched, response } = await rpc.handle(c.req.raw, { prefix });
        if (matched) return response;
        return next();
      });
      return getRequestListener((raw) => app.fetch(raw), { overrideGlobalObjects: false });
    },
  });
};

/**
 * The router's port and provider in one call: `HttpRouter("OrderRouter")([PlaceOrder,
 * FindOrder], { sync: routerOf })`. The first call mints a port named
 * `name` whose service is a context-free oRPC router — the one shape
 * `http()` accepts — and returns di's own `Provider(port)`, so the second
 * call is exactly what it is everywhere else: any arm, same typing, and the
 * provider it hands back carries the port typed (`orderRouter.port`) for
 * `HttpModule({ router: orderRouter })` and for whoever else names it. The
 * class line and its `ReturnType<typeof routerOf>` are what disappear.
 */
export const HttpRouter = <const Name extends string>(
  name: Name,
): ReturnType<typeof Provider<RouterPortClass<Name>>> =>
  // The class expression's own type expands the port's brand keys in
  // declaration emit and cannot be named by a consumer; `RouterPortClass`
  // spells the same class through the exported `PortInstance`, and is what
  // the returned provider's `.port` is typed as.
  Provider(class extends Port(name)<Router<Record<never, never>>> {} as RouterPortClass<Name>);

/** The port `HttpRouter(name)` mints: id `Name`, service a context-free oRPC router. */
export type RouterPortClass<Name extends string> = {
  readonly portId: Name;
  new (): PortInstance<Name, Router<Record<never, never>>>;
};
