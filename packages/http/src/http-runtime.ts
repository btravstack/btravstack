import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import {
  RuntimePort,
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

/** What the runtime publishes once it is listening, read back through `RunningApp.runtimeInfo()`. */
export type HttpInfo = { readonly port: number };

/**
 * The one port this runtime needs: the application's HTTP surface, as a
 * service. Provide it in the module `start` boots — at application scope, or
 * in the `StartOptions.unit` module when the handler wants per-request
 * dependencies (a transaction) constructor-injected — and the runtime resolves
 * it out of each unit's context. Nothing else about the transport is the
 * application's to wire.
 *
 * Everything the client receives must be written from inside the handler —
 * the unit stays open until the response completes, so there is no way to be
 * late. It returns `PromiseLike<unknown>` rather than `void`: the package
 * needs to know when the handler is finished so it can answer a request the
 * handler declined, and a `void`-returning handler writing asynchronously
 * would draw a premature `404` over a response still in flight. `unknown`
 * because oRPC's `handle` resolves `{ matched: boolean }`; the value is never
 * the unit's result.
 */
export class HttpHandler extends Port("HttpHandler")<
  (request: IncomingMessage, response: ServerResponse, signal: AbortSignal) => PromiseLike<unknown>
> {}

export type HttpOptions = {
  /** `0` lets the OS pick — read it back from `RunningApp.runtimeInfo()`. */
  readonly port: number;
  /** Default `0.0.0.0`: the deployment target is a pod, not a laptop. */
  readonly hostname?: string;
};

const DEFAULT_HOSTNAME = "0.0.0.0";

/** The runtime's port: what `httpModule` provides, and what the module `start` boots must export. */
export class HttpRuntime extends RuntimePort<Runtime<typeof HttpHandler, HttpInfo>> {}

const httpRuntime = (options: HttpOptions): Runtime<typeof HttpHandler, HttpInfo> => ({
  name: "http",
  needs: [HttpHandler],
  start: (host) => listen(host, options),
});

/** The runtime as a module: import it next to the application and export `HttpRuntime`. */
export const httpModule = (options: HttpOptions): Module<HttpRuntime, never, never> =>
  Module("Http")({
    provides: [Provider(HttpRuntime)({ value: httpRuntime(options) })],
    exports: [HttpRuntime],
  });

const listen = (
  host: RuntimeHost<typeof HttpHandler>,
  options: HttpOptions,
): AsyncResult<Serving<HttpInfo>, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<Serving<HttpInfo>, RuntimeStartFailed>>((resolve) => {
      // `close()` waits for every connection to end, and a keep-alive client
      // holds one open long after its response. Tracking sockets is what lets
      // `stop` destroy them instead of hanging.
      const sockets = new Set<Socket>();

      // Responses still open, so the drain can retire them.
      // `closeIdleConnections()` reaches every connection IDLE at that instant
      // and no others — one with a request in flight survives it, and node
      // happily serves further requests down that one for the whole drain
      // window. `Connection: close` is what actually retires the socket: node
      // closes it once the response ends.
      const open = new Set<ServerResponse>();
      let draining = false;

      const retire = (response: ServerResponse): void => {
        if (!response.headersSent) {
          response.setHeader("Connection", "close");
          return;
        }
        // Headers already on the wire: no header left to change, so the socket
        // is ended once the response is out. Keeps the guarantee "no reuse"
        // rather than "no reuse where we caught the header in time".
        const { socket } = response;
        response.once("finish", () => void socket?.end());
      };

      const server: Server = createServer((request, response) => {
        open.add(response);
        response.once("close", () => open.delete(response));
        if (draining) retire(response);
        // The unit's `Result` is FOLDED to a value here rather than dropped:
        // `AsyncResult<T, never>` has an empty *error* channel, but a `Defect`
        // can still be present. `recoverDefect`, not `match`: `E` is
        // statically `never` at this call site, so a `match`'s `errCases` arm
        // would be an always-dead branch with no case to name.
        void host
          .run(metaFor(request), (ctx, signal) => {
            void answer(ctx.get(HttpHandler)(request, response, signal), response);
            // The unit's lifetime IS the response's. This is what makes the
            // kernel's "flush inside the unit" contract structural rather than
            // documented: there is no way to write late, because the unit is
            // still open until the bytes are out.
            return closedOf(response);
          })
          .recoverDefect((cause) => {
            // The unit failed outside `answer`'s reach — the handler threw
            // synchronously, or a `StartOptions.unit` provider failed to build —
            // so this is where the `500` is written; `destroy` is the last
            // courtesy left once headers are already on the wire, so a client
            // that would otherwise hang gets a reset. Guarded so this callback
            // cannot throw — `recoverDefect` would wrap a throw here into a
            // FRESH defect, and the `void` below would drop it.
            try {
              end(response, 500, "InternalError");
              if (!response.writableEnded)
                response.destroy(cause instanceof Error ? cause : undefined);
            } catch {
              // nothing left to try; the socket is already unusable
            }
            return OkAsync();
          });
      });

      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
      });

      const closed = new Promise<void>((done) => {
        server.once("close", () => done());
      });

      const stopAccepting = (): void => {
        draining = true;
        // Marked HERE rather than in the request callback, which ran before the
        // drain existed — these are precisely the responses holding a connection
        // open past `closeIdleConnections()`.
        for (const response of open) retire(response);
        if (!server.listening) return;
        server.close();
        server.closeIdleConnections();
      };

      const onBindError = (cause: unknown): void => {
        resolve(Err(new RuntimeStartFailed({ runtime: "http", cause })));
      };

      // Permanent, and deliberately NOT `onBindError`: once the bind has
      // settled the deferred, routing a later error there could only resolve
      // an already-settled promise. But leaving the server with ZERO
      // `'error'` listeners is worse — an unhandled `'error'` throws, and the
      // kernel's `uncaughtException` handler turns that into a
      // whole-application teardown over a transient accept fault.
      const ignoreServingError = (): void => {};

      server.once("error", onBindError);

      // `listen` validates the port SYNCHRONOUSLY and throws `ERR_SOCKET_BAD_PORT`
      // rather than emitting `'error'` — for a non-integer and for anything
      // outside 0..65535 alike. Uncaught, that throw escapes this executor,
      // rejects the promise, and reaches the caller as a Defect, bypassing the
      // `AsyncResult<Serving, RuntimeStartFailed>` this function declares.
      try {
        server.listen(options.port, options.hostname ?? DEFAULT_HOSTNAME, () => {
          server.removeListener("error", onBindError);
          server.on("error", ignoreServingError);

          const address = server.address();
          const port =
            typeof address === "object" && address !== null ? address.port : options.port;

          resolve(
            Ok({
              info: { port },
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
      } catch (cause) {
        onBindError(cause);
      }
    }),
  ).flatMap((result) => result);

// `closed` is checked first because the unit's work is not always synchronous
// with the request: under a `StartOptions.unit` module it runs once the fork is
// built, and a client that hung up in the meantime has already emitted
// `'close'` — subscribing then would hold the unit open for the process
// lifetime.
const closedOf = (response: ServerResponse): AsyncResult<void, never> =>
  response.closed
    ? OkAsync()
    : fromSafePromise(new Promise<void>((done) => response.once("close", () => done())));

/**
 * `UnitMeta.traceId` defaults to `id`, so `id` is minted fresh per request and
 * never taken from the route: a category there would give every request the same
 * trace id and silently defeat the ambient record. An inbound `x-request-id`
 * becomes the trace id.
 *
 * Only a NON-BLANK header is adopted: the kernel falls back to `meta.id` when
 * `traceId` is nullish, and `""` is not, so an empty header would win and hand
 * a caller's every request the same blank id — defeating the ambient record
 * exactly as a route template would.
 */
const metaFor = (request: IncomingMessage): UnitMeta => {
  const inbound = request.headers["x-request-id"];
  const traceId = typeof inbound === "string" ? inbound.trim() : "";
  return {
    kind: "http",
    id: randomUUID(),
    ...(traceId === "" ? {} : { traceId }),
  };
};

/**
 * The package's guarantee: every request produces exactly one completed
 * response. A handler that declines (resolves without writing) gets a `404`; one
 * that fails gets a `500`. Without this the response never ends, the client
 * hangs, and the unit stays counted in flight until the drain deadline.
 *
 * An `AsyncResult` carrying an `Err` or a `Defect` RESOLVES rather than rejects,
 * so it lands in the `404` branch. That is correct: this package does not map
 * `Result` → status, and a handler that hands one back has not answered.
 */
const answer = async (handled: PromiseLike<unknown>, response: ServerResponse): Promise<void> => {
  try {
    await handled;
    end(response, 404, "NotFound");
  } catch {
    // Guarded so a throw here cannot reject `answer`'s own promise: the call
    // site drops it with `void`, and an unhandled rejection is exactly the
    // whole-application teardown the permanent `'error'` listener above
    // exists to prevent.
    try {
      end(response, 500, "InternalError");
    } catch {
      // nothing left to try; the response is already unusable
    }
  }
};

// Silent when the handler has already started writing: there is no status left
// to set, and the response is the handler's to finish.
const end = (response: ServerResponse, status: number, error: string): void => {
  if (response.headersSent || response.writableEnded || response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error }));
};
