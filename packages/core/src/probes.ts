import { createServer, type Server, type ServerResponse } from "node:http";

import { Err, Ok, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import { RuntimeStartFailed } from "./runtime.js";

export type ProbeServer = {
  readonly port: number;
  readonly close: () => AsyncResult<void, never>;
};

export type ProbeArgs = {
  readonly port: number;
  readonly live: () => boolean;
  readonly ready: () => boolean;
};

// There is deliberately no startup probe: `/livez` answers from `building`
// onward (see `start.ts`), so a slow-building graph is covered by `/readyz`
// alone.
export const startProbeServer = (args: ProbeArgs): AsyncResult<ProbeServer, RuntimeStartFailed> =>
  fromSafePromise(
    new Promise<Result<ProbeServer, RuntimeStartFailed>>((resolve) => {
      const server: Server = createServer((request, response) => {
        if (request.url === "/livez") {
          respond(response, args.live(), "ok");
          return;
        }
        if (request.url === "/readyz") {
          respond(response, args.ready(), "ready");
          return;
        }
        response.writeHead(404).end();
      });

      const onBindError = (cause: unknown): void => {
        resolve(Err(new RuntimeStartFailed({ runtime: "probes", cause })));
      };

      // Permanent, and deliberately not `onBindError`, which could only resolve
      // an already-settled promise. Zero `'error'` listeners is worse: an
      // unhandled `'error'` throws, and the kernel's `uncaughtException` handler
      // turns that into a whole-application teardown over a health endpoint.
      const ignoreServingError = (): void => {};

      server.once("error", onBindError);

      // `listen` validates the port synchronously and THROWS
      // `ERR_SOCKET_BAD_PORT` rather than emitting `'error'`. Uncaught, that
      // escapes the executor and reaches the caller as a defect, bypassing the
      // `RuntimeStartFailed` this function declares.
      try {
        server.listen(args.port, "127.0.0.1", () => {
          server.removeListener("error", onBindError);
          server.on("error", ignoreServingError);

          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : args.port;
          resolve(
            Ok({
              port,
              // Node's own close error is discarded: both dispose sites may
              // fire, and the second reports `ERR_SERVER_NOT_RUNNING`.
              close: () => fromSafePromise(new Promise<void>((done) => server.close(() => done()))),
            }),
          );
        });
      } catch (cause) {
        onBindError(cause);
      }

      server.unref();
    }),
  ).flatMap((result) => result);

const respond = (response: ServerResponse, healthy: boolean, body: string): void => {
  if (healthy) {
    response.writeHead(200).end(body);
    return;
  }
  response.writeHead(503).end("unavailable");
};
