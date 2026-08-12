import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

import type { AnyPort, Context } from "@btravstack/di";
import {
  RuntimeStartFailed,
  type Runtime,
  type RuntimeHost,
  type Serving,
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

      const server: Server = createServer((_request, response) => {
        void host;
        response.end();
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

      server.once("error", onBindError);

      server.listen(options.port, options.hostname ?? DEFAULT_HOSTNAME, () => {
        server.removeListener("error", onBindError);

        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : options.port;

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
    }),
  ).flatMap((result) => result);
