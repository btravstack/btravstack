import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { AnyPort, Context } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
  type UnitMeta,
} from "@btravstack/start";
import { Err, Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";

/** What the runtime publishes once it is listening, read back through `RunningApp.runtimeInfo()`. */
export type HttpInfo = { readonly port: number };

/**
 * One request. Everything the client receives must be written from here — the
 * unit stays open until the response completes, so there is no way to be late.
 *
 * Returns `PromiseLike<unknown>` rather than `void`: the package needs to know
 * when the handler is finished so it can answer a request the handler declined,
 * and a `void`-returning handler writing asynchronously would draw a premature
 * `404` over a response still in flight. `unknown` because oRPC's `handle`
 * resolves `{ matched: boolean }`; the value is never the unit's result.
 */
export type HttpHandler<Needs extends AnyPort> = (
  request: IncomingMessage,
  response: ServerResponse,
  ctx: Context<InstanceType<Needs>>,
  signal: AbortSignal,
) => PromiseLike<unknown>;

export type HttpOptions<Needs extends AnyPort> = {
  /** `0` lets the OS pick — read it back from `RunningApp.runtimeInfo()`. */
  readonly port: number;
  /** Default `0.0.0.0`: the deployment target is a pod, not a laptop. */
  readonly hostname?: string;
  readonly needs: readonly Needs[];
  readonly handler: HttpHandler<Needs>;
};

const DEFAULT_HOSTNAME = "0.0.0.0";

export const httpRuntime = <Needs extends AnyPort>(
  options: HttpOptions<Needs>,
): Runtime<Needs, HttpInfo> => ({
  name: "http",
  needs: options.needs,
  start: (host: RuntimeHost<Needs>) => listen(host, options),
});

const listen = <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
  options: HttpOptions<Needs>,
): AsyncResult<Serving<HttpInfo>, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<Serving<HttpInfo>, RuntimeStartFailed>>((resolve) => {
      // `close()` waits for every connection to end, and a keep-alive client
      // holds one open long after its response. Tracking sockets is what lets
      // `stop` destroy them instead of hanging.
      const sockets = new Set<Socket>();

      const server: Server = createServer((request, response) => {
        // The unit's `Result` is FOLDED to a value here rather than dropped:
        // `AsyncResult<T, never>` has an empty *error* channel, but a `Defect`
        // can still be present.
        void host
          .run(metaFor(request), (ctx, signal) => {
            void answer(options.handler(request, response, ctx, signal));
            // The unit's lifetime IS the response's. This is what makes the
            // kernel's "flush inside the unit" contract structural rather than
            // documented: there is no way to write late, because the unit is
            // still open until the bytes are out.
            return closedOf(response);
          })
          .match({
            ok: () => {},
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

      const closed = new Promise<void>((done) => {
        server.once("close", () => done());
      });

      const stopAccepting = (): void => {
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

const closedOf = (response: ServerResponse): AsyncResult<void, never> =>
  fromSafePromise(new Promise<void>((done) => response.once("close", () => done())));

/**
 * `UnitMeta.traceId` defaults to `id`, so `id` is minted fresh per request and
 * never taken from the route: a category there would give every request the same
 * trace id and silently defeat the ambient record. An inbound `x-request-id`
 * becomes the trace id.
 */
const metaFor = (request: IncomingMessage): UnitMeta => {
  const inbound = request.headers["x-request-id"];
  return {
    kind: "http",
    id: randomUUID(),
    ...(typeof inbound === "string" ? { traceId: inbound } : {}),
  };
};

const answer = async (handled: PromiseLike<unknown>): Promise<void> => {
  try {
    await handled;
  } catch {
    // Task 6 turns this into the 500 the client is owed.
  }
};
