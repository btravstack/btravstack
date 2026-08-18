import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { Config, type ConfigInvalid, type Env } from "@btravstack/config";
import {
  RuntimePort,
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/core";
import { Module, Port, Provider, type ServiceOf } from "@btravstack/di";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { HttpHandler } from "./handler.js";
import { orpc, type HttpRouterPort } from "./orpc.js";

/** What the runtime publishes once it is listening, read back through `RunningApp.runtimeInfo()`. */
export type HttpInfo = { readonly port: number };

/**
 * What the socket is bound with, as a service: `http()` binds it from the
 * environment — `PORT` (default `3000`; `0` lets the OS pick, read it back
 * from `RunningApp.runtimeInfo()`) and `HOST` (default `0.0.0.0`: the
 * deployment target is a pod, not a laptop) — and anything else in the graph
 * may read it.
 */
export class HttpConfig extends Port("HttpConfig")<{
  readonly port: number;
  readonly hostname: string;
}> {}

/**
 * `http()`'s options: where the router is mounted, and what a caller pins
 * instead of reading from the environment — a test's `{ port: 0 }`. The router
 * itself is not an option: it is the provider the composition root supplies
 * on the starter's own router port (`HttpRouter(contract)(deps, arm)`), which
 * this module needs.
 */
/**
 * Reads the tenant off a request and puts it on the kernel's ambient unit
 * record, where an infrastructure adapter can find it. The whole request is
 * handed over because only the application knows where its tenant lives — a
 * header, a subdomain, a path segment. A blank or missing answer means no
 * tenant, which is what a single-tenant deployment wants and what every
 * version of this package before it did.
 *
 * This starter maps nothing beyond that: `tenantId` reaches the record and
 * stops there. Refusing a request that carries no tenant is a decision about
 * a status code, and the package declines those (root `CLAUDE.md`, thesis 3)
 * — it belongs in a procedure, next to the rest of the triage.
 */
export type TenantOf = (request: IncomingMessage) => string | undefined;

export type HttpOptions = {
  /** Where the RPC endpoint is mounted. Default `/rpc`. */
  readonly prefix?: `/${string}`;
  readonly port?: number;
  readonly hostname?: string;
  /** See {@link TenantOf}. */
  readonly tenantOf?: TenantOf;
};

/** The runtime's port: what `http()` provides, and what the module `start` boots must export. */
export class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}

const httpRuntime = (
  config: ServiceOf<HttpConfig>,
  handler: ServiceOf<HttpHandler>,
  tenantOf: TenantOf | undefined,
): Runtime<never, HttpInfo> => ({
  name: "http",
  needs: [],
  start: (host) => listen(host, config, handler, tenantOf),
});

/**
 * The runtime and its configuration as a module, over whichever `HttpHandler`
 * provider it is handed: `http()` hands it the oRPC one; the package's own
 * transport specs hand it a bare listener. INTERNAL for that second reason
 * only.
 *
 * With every field pinned the module reads nothing from the environment; the
 * declared `Env` need and `ConfigInvalid` stay (the kernel discharges the
 * one, a pinned config never produces the other) — one signature, no
 * overload pair to keep in step.
 */
export const httpModule = <N>(
  options: { readonly port?: number; readonly hostname?: string; readonly tenantOf?: TenantOf },
  handler: Provider<HttpHandler, never, N>,
): Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | N> => {
  const { port, hostname, tenantOf } = options;
  const config =
    port !== undefined && hostname !== undefined
      ? Provider(HttpConfig)({ value: { port, hostname } })
      : Config.provider(HttpConfig)(
          Config.object({
            port: Config.pinned(port, Config.port("PORT", { default: 3000 })),
            hostname: Config.pinned(hostname, Config.string("HOST", { default: "0.0.0.0" })),
          }),
        );
  return Module("Http")({
    provides: [
      config,
      handler,
      Provider(HttpRuntime)([HttpConfig, HttpHandler], {
        sync: (c, h) => httpRuntime(c, h, tenantOf),
      }),
    ],
    exports: [HttpRuntime, HttpConfig],
  }) as unknown as Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | N>;
};

/**
 * The HTTP starter, and the one way HTTP is answered here: oRPC. A
 * module providing the runtime (`HttpRuntime`), its configuration
 * (`HttpConfig`, bound from `PORT`/`HOST` unless pinned) and the HTTP surface
 * built from the application's **router** — a provider on the starter's own
 * router port, built by `HttpRouter(contract)(deps, arm)` from the use cases
 * its procedures call, which this module NEEDS: a composition root that
 * imports the starter without providing a router owes the port, and di's
 * gate says so. `http()` mounts it under `prefix` and puts the listener on
 * the socket. Import it next to the application, provide the router, export
 * `HttpRuntime`, and that is the whole of the transport wiring: no handler,
 * no `needs`, no context handed to a procedure.
 *
 * Pin `port`/`hostname` and the module reads nothing from the environment
 * (the declared `Env` need and `ConfigInvalid` stay — the kernel discharges
 * the one, a pinned config never produces the other); pin only some and the
 * rest still comes from the environment.
 */
export const http = (
  options: HttpOptions = {},
): Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort> => {
  const { prefix, ...socket } = options;
  return httpModule(socket, orpc(prefix === undefined ? {} : { prefix }));
};

const listen = (
  host: RuntimeHost<never>,
  options: ServiceOf<HttpConfig>,
  handler: ServiceOf<HttpHandler>,
  tenantOf: TenantOf | undefined,
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
          .run(metaFor(request, tenantOf?.(request)), (_ctx, signal) => {
            void answer(handler(request, response, signal), response);
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
        server.listen(options.port, options.hostname, () => {
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
const metaFor = (request: IncomingMessage, tenantId: string | undefined): UnitMeta => {
  const inbound = request.headers["x-request-id"];
  const traceId = typeof inbound === "string" ? inbound.trim() : "";
  // Trimmed and refused blank for the same reason the trace id is: `""` is not
  // nullish, so a client sending an empty tenant header would otherwise put one
  // on the record that every adapter then scopes by.
  const tenant = tenantId?.trim();
  return {
    kind: "http",
    id: randomUUID(),
    ...(traceId === "" ? {} : { traceId }),
    ...(tenant === undefined || tenant === "" ? {} : { tenantId: tenant }),
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
