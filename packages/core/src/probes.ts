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

      // Permanent, and deliberately not `onBindError`: once the bind has
      // settled the deferred, routing a later error there could only resolve an
      // already-settled promise. But leaving the server with ZERO `'error'`
      // listeners is worse — `net.Server` still emits `'error'` after listening
      // (an accept failure such as `EMFILE`), and an unhandled `'error'` throws,
      // which the kernel's own `uncaughtException` handler would turn into a
      // whole-application teardown over a fault in its health endpoint. The
      // socket is `unref`'d and dispose-only, so there is nothing to report.
      const ignoreServingError = (): void => {};

      server.once("error", onBindError);

      // `listen` validates the port SYNCHRONOUSLY and throws `ERR_SOCKET_BAD_PORT`
      // rather than emitting `'error'` — for a non-integer and for anything
      // outside 0..65535 alike. Uncaught, that throw escapes this executor,
      // rejects the promise and reaches the caller as a Defect, bypassing the
      // `AsyncResult<ProbeServer, RuntimeStartFailed>` this function declares.
      // `probes: { port: Number(process.env.PROBE_PORT) }` is how it arrives.
      try {
        server.listen(args.port, "127.0.0.1", () => {
          server.removeListener("error", onBindError);
          server.on("error", ignoreServingError);

          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : args.port;
          resolve(
            Ok({
              port,
              // Node's own close error is discarded deliberately — both dispose
              // sites may fire, and the second reports `ERR_SERVER_NOT_RUNNING`
              // through the callback (it does not throw; measured on v24).
              //
              // This route is NOT relied upon to be defect-free. `start.ts`'s
              // `disposeProbes` drops the `Result`, but on the grounds that a
              // failed close during exit is unactionable — see the comment there.
              // A `Defect` escaping here would be correctly discarded too, so
              // neither side depends on node's throwing behaviour staying put.
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
