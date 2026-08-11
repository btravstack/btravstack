import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { Module } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/start";
import { FindOrder, Logger, PlaceOrder } from "@btravstack/start-example-order-application";
import { RPCHandler } from "@orpc/server/node";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { RequestModule } from "./request-scope.js";
import { orderRouter, type ApiContext } from "./router.js";

/**
 * What the runtime publishes about itself once it is up, read back through
 * `RunningApp.runtimeInfo()`.
 *
 * This is the whole reason a runtime binding `port: 0` needs no hook of its
 * own: `Serving.info` is the kernel's channel for exactly this, so there is no
 * `onListening` callback and no `boundPort()` accessor to keep in sync.
 */
export type OrderApiInfo = { readonly port: number; readonly prefix: `/${string}` };

export type OrderApiOptions = {
  /** `0` lets the OS pick — read the result back from `runtimeInfo()`. */
  readonly port: number;
  readonly hostname?: string;
  readonly prefix?: `/${string}`;
};

/**
 * The ports this runtime resolves out of the application context. Non-empty on
 * purpose: it is what makes `start`'s arity gate mean something — a module that
 * does not export all three fails to compile at the `start(...)` call, before
 * anything runs. `Logger` is not read here directly; the per-request scope
 * forked below needs it, and a fork can only reach what the parent context
 * carries.
 */
type ApiNeeds = typeof PlaceOrder | typeof FindOrder | typeof Logger;

/**
 * A `Runtime` serving the order application over oRPC.
 *
 * The three methods of the contract, and how they differ:
 *
 * - `start` binds the socket, publishes the bound port on `Serving.info`, and
 *   hands back a `Serving`. A bind failure is a modeled `Err(RuntimeStartFailed)`,
 *   never a throw.
 * - `Serving.drain` stops *accepting*: it closes the listener and the idle
 *   keep-alive connections, and leaves requests already in flight to run to
 *   completion. The kernel's deadline signal has nothing to cancel here — the
 *   in-flight units are the kernel's to time out.
 * - `Serving.stop` closes for good and **destroys** every remaining socket.
 *   Without that, `close()` would wait out a keep-alive connection that has no
 *   request on it, and the process would never exit.
 */
export const orpcRuntime = (options: OrderApiOptions): Runtime<ApiNeeds, OrderApiInfo> => ({
  name: "orpc",
  needs: [PlaceOrder, FindOrder, Logger],
  start: (host: RuntimeHost<ApiNeeds>) => listen(host, options),
});

const listen = (
  host: RuntimeHost<ApiNeeds>,
  options: OrderApiOptions,
): AsyncResult<Serving<OrderApiInfo>, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<Serving<OrderApiInfo>, RuntimeStartFailed>>((resolve) => {
      const prefix = options.prefix ?? "/rpc";
      const handler = new RPCHandler(orderRouter);
      // A `node:http` server's `close` waits for every connection to end, and a
      // keep-alive client holds one open long after its response. Tracking the
      // sockets is what lets `stop` destroy them instead of hanging.
      const sockets = new Set<Socket>();

      const server = createServer((request, response) => {
        // node's request callback returns `void`, so the unit's outcome is
        // FOLDED to a value here rather than dropped: `AsyncResult<T, never>`
        // has an empty *error* channel, but a `Defect` can still be present.
        void dispatch(host, handler, prefix, request, response).match({
          ok: () => {},
          // Nothing can land in the error channel — the work below is typed
          // `AsyncResult<void, never>` — so the matcher has no case to name.
          errCases: (matcher) => matcher,
          // Reached only if the response machinery itself failed, which leaves
          // nothing left to write. Killing the socket is the one remaining
          // courtesy: a client that would otherwise hang gets a reset.
          defect: (cause) => {
            response.destroy(cause instanceof Error ? cause : undefined);
          },
        });
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      // Resolves when the listener is closed *and* the last connection has
      // ended. Registered once, here, so `stop` never has to reason about
      // whether `drain` already closed the listener.
      const closed = new Promise<void>((done) => {
        server.once("close", () => done());
      });

      const stopAccepting = (): void => {
        if (!server.listening) return;
        server.close();
        // An idle keep-alive connection is not in-flight work: leaving it open
        // would let a client send another request down it after the drain.
        server.closeIdleConnections();
      };

      const onBindError = (cause: Error): void => {
        resolve(Err(new RuntimeStartFailed({ runtime: "orpc", cause })));
      };

      server.once("error", onBindError);

      server.listen(options.port, options.hostname ?? "127.0.0.1", () => {
        server.removeListener("error", onBindError);

        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : options.port;

        resolve(
          Ok({
            info: { port, prefix },
            drain: (signal) => {
              void signal;
              stopAccepting();
              return OkAsync();
            },
            stop: () => {
              stopAccepting();
              for (const socket of sockets) socket.destroy();
              sockets.clear();
              return fromSafePromise(closed);
            },
          }),
        );
      });
    }),
  ).flatMap((result) => result);

/**
 * One request, one unit.
 *
 * Everything the client receives is flushed **inside** the unit: oRPC's
 * `handle` resolves only once the response has closed, so the unit stays open
 * until the bytes are on the wire. Returning earlier and writing afterwards
 * would race `Serving.stop` destroying the socket.
 */
const dispatch = (
  host: RuntimeHost<ApiNeeds>,
  handler: RPCHandler<ApiContext>,
  prefix: `/${string}`,
  request: IncomingMessage,
  response: ServerResponse,
): AsyncResult<void, never> =>
  host.run(metaFor(request), (ctx, _signal) =>
    // The application scope belongs to the kernel and holds the database; this
    // layers a per-request scope over it, so a request-scoped provider is torn
    // down with the request and the parent's services are seeded, not rebuilt.
    // The callback is deliberately synchronous — an `async` one would infer
    // `Promise<Result<…>>`, which has none of the combinators.
    Module.forkScope(ctx, RequestModule, (scope) =>
      fromSafePromise(handler.handle(request, response, { prefix, context: { scope } }))
        .flatMap((outcome) => (outcome.matched ? OkAsync() : endWith(response, 404, "NoProcedure")))
        // A failure of the transport itself — not of a procedure, which oRPC
        // has already turned into a response. Answering here keeps the 500
        // inside the unit like every other response.
        .recoverDefect(() => endWith(response, 500, "InternalError")),
    ),
  );

const endWith = (
  response: ServerResponse,
  status: number,
  error: string,
): AsyncResult<void, never> => {
  if (response.writableEnded || response.destroyed) return OkAsync();

  response.writeHead(status, { "content-type": "application/json" });
  return fromSafePromise(
    new Promise<void>((done) => {
      response.end(JSON.stringify({ error }), () => done());
    }),
  );
};

/**
 * `UnitMeta.traceId` defaults to `id`, so `id` is minted fresh per request
 * rather than set to the route: a category there would give every request the
 * same trace id and silently defeat the ambient record. An inbound
 * `x-request-id` becomes the trace id — the correlation id is the one a caller
 * outside this process is entitled to choose.
 */
const metaFor = (request: IncomingMessage): UnitMeta => {
  const inbound = request.headers["x-request-id"];
  return {
    kind: "rpc",
    id: randomUUID(),
    ...(typeof inbound === "string" ? { traceId: inbound } : {}),
  };
};
