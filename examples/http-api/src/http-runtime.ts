import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { text } from "node:stream/consumers";
import { finished } from "node:stream/promises";

import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
} from "@btravstack/start";
import { Err, Ok, OkAsync, P, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { Router, type Handler } from "./app.js";

export type HttpRuntimeOptions = {
  readonly port: number;
  /**
   * Called once with the port the server actually bound — the only way a caller
   * learns it when `port` is `0`. The kernel reports a *probe* server's port
   * through `RunningApp.probePort()`, but `Runtime` has no channel of its own
   * for a runtime's address, so a runtime that wants to publish one hands out a
   * hook like this.
   */
  readonly onListening?: (port: number) => void;
};

type RouterService = { readonly route: (method: string, path: string) => Handler | undefined };

/**
 * A `Runtime` over `node:http`, serving the order application.
 *
 * The three methods of the contract, and what each means here:
 *
 * - `start` binds the socket and hands back a `Serving`. A bind failure is a
 *   modeled `Err(RuntimeStartFailed)`, never a throw.
 * - `Serving.drain` stops *accepting*: it closes the listener and the idle
 *   keep-alive connections, leaving requests already in flight to finish.
 * - `Serving.stop` closes for good and destroys whatever sockets remain.
 *
 * `needs: [Router]` is the whole dependency: the kernel resolves it from the
 * application module's exports (a compile error at `start` if the module does
 * not export one) and `host.ctx.get(Router)` is the only lookup here.
 */
export const httpRuntime = (options: HttpRuntimeOptions): Runtime<typeof Router> => ({
  name: "http",
  needs: [Router],
  start: (host: RuntimeHost<typeof Router>) => listen(host, options),
});

const listen = (
  host: RuntimeHost<typeof Router>,
  options: HttpRuntimeOptions,
): AsyncResult<Serving, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<Serving, RuntimeStartFailed>>((resolve) => {
      const router = host.ctx.get(Router);
      // A `node:http` server's `close` waits for every connection to end, and a
      // keep-alive client holds one open long after its response. Tracking the
      // sockets is what lets `stop` destroy them instead of hanging.
      const sockets = new Set<Socket>();

      const server = createServer((request, response) => {
        void onRequest(host, router, request, response);
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

      const serving: Serving = {
        drain: (signal) => {
          // The kernel's deadline signal has nothing to abort here: stopping
          // acceptance is synchronous, and the in-flight requests it leaves
          // running are the kernel's to time out.
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
      };

      const onBindError = (cause: Error): void => {
        resolve(Err(new RuntimeStartFailed({ runtime: "http", cause })));
      };

      server.once("error", onBindError);

      server.listen(options.port, "127.0.0.1", () => {
        server.removeListener("error", onBindError);

        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : options.port;
        options.onListening?.(port);

        resolve(Ok(serving));
      });
    }),
  ).flatMap((result) => result);

/**
 * Never rejects: a throw anywhere in dispatch — including out of the
 * application's own `route` — becomes a `Defect`, which the last arm turns into
 * a 500. That is what makes the `void onRequest(...)` above safe.
 */
const onRequest = (
  host: RuntimeHost<typeof Router>,
  router: RouterService,
  request: IncomingMessage,
  response: ServerResponse,
): AsyncResult<void, never> =>
  OkAsync()
    .flatMap(() => dispatch(host, router, request, response))
    .recoverDefect(() => {
      respond(response, 500, { error: "InternalError" });
      return Ok();
    });

const dispatch = (
  host: RuntimeHost<typeof Router>,
  router: RouterService,
  request: IncomingMessage,
  response: ServerResponse,
): AsyncResult<void, never> => {
  const method = request.method ?? "GET";
  const path = request.url ?? "/";
  const handler = router.route(method, path);

  // No route, no unit: an unknown path never reaches the application.
  if (handler === undefined) {
    respond(response, 404, { error: "NoRoute" });
    return OkAsync();
  }

  return host.run(
    { kind: "http", id: `${method} ${path}`, traceId: traceIdOf(request) },
    (_ctx, signal) => serve(handler, request, response, method === "POST" ? 201 : 200, signal),
  );
};

/**
 * The one place a `Result` becomes a status. The kernel never sees it: mapping
 * a domain failure onto HTTP is the edge's job, and every case is named — the
 * matcher stops compiling if the application grows a third error and this file
 * does not grow an arm for it.
 */
const serve = (
  handler: Handler,
  request: IncomingMessage,
  response: ServerResponse,
  okStatus: number,
  signal: AbortSignal,
): AsyncResult<void, never> =>
  fromSafePromise(
    (async () => {
      // The example's `Handler` takes only a body, so the unit's signal cannot
      // reach it; the most a request can do with the kernel's deadline is stop
      // leaving its client hanging.
      signal.addEventListener("abort", () => respond(response, 503, { error: "Aborted" }), {
        once: true,
      });

      const outcome = await fromSafePromise(text(request)).flatMap((raw) => handler(parse(raw)));

      outcome.match({
        ok: (value) => respond(response, okStatus, value),
        errCases: (matcher) =>
          matcher
            .with(P.tag("DuplicateOrder"), (error) => respond(response, 409, { error: error._tag }))
            .with(P.tag("OrderNotFound"), (error) => respond(response, 404, { error: error._tag })),
        defect: () => respond(response, 500, { error: "InternalError" }),
      });

      // Keeps the unit open until the bytes are on the wire: the kernel counts a
      // unit as completed the moment its work settles, and `stop` destroys
      // sockets, so returning before the flush would race the response away.
      await finished(response);
    })(),
  );

const parse = (raw: string): unknown => (raw === "" ? undefined : JSON.parse(raw));

const traceIdOf = (request: IncomingMessage): string => {
  const header = request.headers["x-request-id"];
  return typeof header === "string" ? header : randomUUID();
};

const respond = (response: ServerResponse, status: number, body: unknown): void => {
  if (response.writableEnded || response.destroyed) return;
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body ?? null));
};
