import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import { Config, Env, type ConfigInvalid } from "@btravstack/config";
import {
  RuntimePort,
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/core";
import { Module, Provider, type ServiceOf } from "@btravstack/di";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { HttpHandler } from "./handler.js";
import { HttpConfig } from "./http-config.js";
import { DEFAULT_BODY_LIMIT, orpc, type HttpRouterPort, type OrpcOptions } from "./orpc.js";

/** What the runtime publishes once it is listening, read back through `RunningApp.runtimeInfo()`. */
export type HttpInfo = { readonly port: number };

/**
 * `http()`'s options: `orpc()`'s own — where the router is mounted, and the
 * transport policy — plus what a caller pins on the socket instead of reading
 * it from the environment. Declared as one intersection so each option is
 * spelled ONCE across the three surfaces that take it (`orpc()`, `http()`,
 * `HttpModule`), which is what the six-concerns claim drifted against when
 * they were three parallel records.
 *
 * The router itself is not an option — it is the provider the composition root
 * supplies on the starter's router port, which this module needs.
 */
export type HttpOptions = OrpcOptions & {
  /** Pins `HttpConfig.port` instead of reading `PORT`. */
  readonly port?: number;
  /** Pins `HttpConfig.hostname` instead of reading `HOST`. */
  readonly hostname?: string;
  /**
   * Headers set on every response, before dispatch. `true` (default) applies
   * {@link DEFAULT_SECURITY_HEADERS}; `false` disables the feature; a record
   * replaces the defaults outright.
   *
   * **Not** a config field, deliberately: a deployment that can silently turn
   * `x-frame-options` off is a footgun the other policies are not.
   */
  readonly securityHeaders?: boolean | Readonly<Record<string, string>>;
};

/** What `httpModule` pins on the config it binds — everything but the router's own. */
type SocketOptions = Pick<
  HttpOptions,
  "port" | "hostname" | "cors" | "bodyLimit" | "compression" | "securityHeaders"
>;

/**
 * Set before dispatch, so they also cover the runtime's own `404` and `500` —
 * which is why they are here and not an oRPC plugin: a plugin runs only for a
 * request oRPC matched.
 */
const DEFAULT_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

/** The runtime's port: what `http()` provides, and what the module `start` boots must export. */
export class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}

const httpRuntime = (
  config: ServiceOf<HttpConfig>,
  handler: ServiceOf<HttpHandler>,
  securityHeaders: HttpOptions["securityHeaders"],
): Runtime<never, HttpInfo> => ({
  name: "http",
  resolves: [],
  start: (host) => listen(host, config, handler, securityHeaders),
});

/**
 * The runtime and its configuration as a module, over whichever `HttpHandler`
 * provider it is handed: `http()` hands it the oRPC one; the package's own
 * transport specs hand it a bare listener. Internal for that second reason
 * only.
 */
export const httpModule = <N>(
  options: SocketOptions,
  handler: Provider<HttpHandler, never, N>,
  // `HttpConfig` is excluded because this module PROVIDES it: the oRPC handler
  // reads the transport policy off it, which is a need discharged in here.
): Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | Exclude<N, HttpConfig>> => {
  const { port, hostname, cors, bodyLimit, compression, securityHeaders } = options;
  const config = Config.provider(HttpConfig)(
    Config.object({
      port: Config.pinned(port, Config.port("PORT", { default: 3000 })),
      hostname: Config.pinned(hostname, Config.string("HOST", { default: "0.0.0.0" })),
      bodyLimit: Config.pinned(
        bodyLimit === false ? 0 : bodyLimit,
        Config.integer("HTTP_BODY_LIMIT", { default: DEFAULT_BODY_LIMIT, min: 0 }),
      ),
      // A record naming its own `origin` is what pins this; `corsOf` prefers
      // the record either way, so nothing here has to spell that precedence
      // twice. `cors: false` pins the empty string, which is "off".
      corsOrigin: Config.pinned(
        cors === false ? "" : undefined,
        Config.string("HTTP_CORS_ORIGIN", { default: "" }),
      ),
      compression: Config.pinned(
        compression === undefined ? undefined : compression !== false,
        Config.boolean("HTTP_COMPRESSION", { default: false }),
      ),
    }),
  );
  return Module("Http")({
    // The handler's own `N` is owed too and cannot be spelled here — it is
    // still a type parameter, which is why the gate defers and the options
    // carry `as never`. The return type states it instead.
    needs: [Env],
    provides: [
      config,
      handler,
      Provider(HttpRuntime)(
        { config: HttpConfig, handler: HttpHandler },
        {
          sync: ({ config: bound, handler: handle }) => httpRuntime(bound, handle, securityHeaders),
        },
      ),
    ],
    exports: [HttpRuntime, HttpConfig],
  } as never) as unknown as Module<
    HttpRuntime | HttpConfig,
    ConfigInvalid,
    Env | Exclude<N, HttpConfig>
  >;
};

/**
 * The HTTP starter, and the one way HTTP is answered here: oRPC. A module
 * providing the runtime, its configuration (bound from `PORT`/`HOST` unless
 * pinned) and the HTTP surface built from the application's router — which this
 * module NEEDS, so a root that imports the starter without providing one owes
 * the port.
 *
 * Pin `port`/`hostname` and the module reads nothing from the environment; pin
 * only some and the rest still comes from it.
 */
export const http = (
  options: HttpOptions = {},
): Module<HttpRuntime | HttpConfig, ConfigInvalid, Env | HttpRouterPort> => {
  // Every field goes to BOTH halves: the scalars pin the config the handler
  // reads, and the shapes (`cors`'s own record, `compression`'s tuning,
  // `plugins`) are composition-time and reach the handler through its closure.
  return httpModule(options, orpc(options));
};

const listen = (
  host: RuntimeHost<never>,
  options: ServiceOf<HttpConfig>,
  handler: ServiceOf<HttpHandler>,
  securityHeaders: HttpOptions["securityHeaders"],
): AsyncResult<Serving<HttpInfo>, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<Serving<HttpInfo>, RuntimeStartFailed>>((resolve) => {
      // Resolved once, outside the per-request callback, entries included.
      const headerRecord: Readonly<Record<string, string>> =
        securityHeaders === false
          ? {}
          : securityHeaders === true || securityHeaders === undefined
            ? DEFAULT_SECURITY_HEADERS
            : securityHeaders;
      const headers = Object.entries(headerRecord);

      // `close()` waits for every connection to end, and a keep-alive client
      // holds one open long after its response. Tracking sockets is what lets
      // `stop` destroy them instead of hanging.
      const sockets = new Set<Socket>();

      // Responses still open, so the drain can retire them.
      // `closeIdleConnections()` reaches every connection idle at that instant
      // and no others — one with a request in flight survives it.
      const open = new Set<ServerResponse>();
      let draining = false;

      const retire = (response: ServerResponse): void => {
        if (!response.headersSent) {
          response.setHeader("Connection", "close");
          return;
        }
        // Headers already on the wire: no header left to change, so the socket
        // is ended once the response is out.
        const { socket } = response;
        response.once("finish", () => void socket?.end());
      };

      const server: Server = createServer((request, response) => {
        // FIRST, before dispatch: covers the runtime's own 404/500 and a
        // drained response alike, not only what oRPC matched.
        for (const [name, value] of headers) response.setHeader(name, value);
        open.add(response);
        response.once("close", () => open.delete(response));
        if (draining) retire(response);
        // `recoverDefect`, not `match`: `E` is statically `never` here, so an
        // `errCases` arm would be a dead branch with no case to name.
        void host
          .run(metaFor(request), (_ctx, signal) => {
            void answer(handler(request, response, signal), response);
            // The unit's lifetime IS the response's, which is what makes the
            // kernel's "flush inside the unit" contract structural here.
            return closedOf(response);
          })
          .recoverDefect((cause) => {
            // The unit failed outside `answer`'s reach — a synchronous throw, or
            // a `StartOptions.unit` provider failing to build. Guarded, because
            // `recoverDefect` would wrap a throw here into a fresh defect that
            // the `void` below drops.
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
        // Marked here rather than in the request callback, which ran before the
        // drain existed — these are the responses holding a connection open
        // past `closeIdleConnections()`.
        for (const response of open) retire(response);
        if (!server.listening) return;
        server.close();
        server.closeIdleConnections();
      };

      const onBindError = (cause: unknown): void => {
        resolve(Err(new RuntimeStartFailed({ runtime: "http", cause })));
      };

      // Permanent, and deliberately not `onBindError`, which could only resolve
      // an already-settled promise. Zero `'error'` listeners is worse: an
      // unhandled `'error'` throws, and the kernel's `uncaughtException` handler
      // turns that into a whole-application teardown over an accept fault.
      const ignoreServingError = (): void => {};

      server.once("error", onBindError);

      // `listen` validates the port synchronously and THROWS
      // `ERR_SOCKET_BAD_PORT` rather than emitting `'error'`. Uncaught, that
      // escapes the executor and reaches the caller as a defect, bypassing the
      // `RuntimeStartFailed` this function declares.
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

// `closed` is checked first because unit work is not always synchronous with the
// request: under a `StartOptions.unit` module it runs once the fork is built, and
// a client that hung up meanwhile has already emitted `'close'` — subscribing
// then would hold the unit open for the process lifetime.
const closedOf = (response: ServerResponse): AsyncResult<void, never> =>
  response.closed
    ? OkAsync()
    : fromSafePromise(new Promise<void>((done) => response.once("close", () => done())));

/**
 * The trace id inside a W3C `traceparent` header, and nothing else of it: the
 * parent's span id is dropped, because `UnitMeta.traceId` is a correlation id
 * rather than a span context. An all-zero trace id is the spec's own "invalid"
 * value and is refused like a malformed header.
 */
const traceIdOfTraceparent = (header: string): string | undefined => {
  const match = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(header.trim());
  const traceId = match?.[1];
  return traceId === undefined || /^0{32}$/.test(traceId) ? undefined : traceId;
};

/**
 * `id` is minted fresh per request and never taken from the route, since
 * `traceId` defaults to it. Inbound, `traceparent` wins over `x-request-id`.
 *
 * Only a NON-BLANK header is adopted: the kernel falls back to `meta.id` when
 * `traceId` is nullish and `""` is not, so an empty header would hand a caller's
 * every request the same blank id.
 */
const metaFor = (request: IncomingMessage): UnitMeta => {
  const parent = request.headers["traceparent"];
  const fromParent = typeof parent === "string" ? traceIdOfTraceparent(parent) : undefined;
  const inbound = request.headers["x-request-id"];
  const traceId = fromParent ?? (typeof inbound === "string" ? inbound.trim() : "");
  return {
    kind: "http",
    id: randomUUID(),
    ...(traceId === "" ? {} : { traceId }),
  };
};

/**
 * The package's guarantee: every request produces exactly one completed
 * response. A handler that declines gets a `404`, one that fails a `500`.
 * Without this the client hangs and the unit stays in flight until the drain
 * deadline.
 *
 * An `AsyncResult` carrying an `Err` or a `Defect` resolves rather than rejects,
 * so it lands in the `404` branch — correct, since a handler that hands one back
 * has not answered.
 */
const answer = async (handled: PromiseLike<unknown>, response: ServerResponse): Promise<void> => {
  try {
    await handled;
    end(response, 404, "NotFound");
  } catch {
    // Guarded so a throw here cannot reject `answer`'s own promise: the call
    // site drops it with `void`, and an unhandled rejection is the
    // whole-application teardown the permanent `'error'` listener prevents.
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
