import { createServer, type Server, type ServerResponse } from "node:http";

import { Err, Ok, fromSafePromise, type AsyncResult, type Result } from "unthrown";

import type { HealthReport } from "./health.js";
import { RuntimeStartFailed } from "./runtime.js";

export type ProbeServer = {
  readonly port: number;
  readonly close: () => AsyncResult<void, never>;
};

export type ProbeArgs = {
  readonly port: number;
  readonly live: () => boolean;
  readonly ready: () => boolean;
  /**
   * Answers `/healthz`. Deliberately NOT folded into `ready`: readiness
   * removes a pod from its Service's endpoints, so failing it on a shared
   * dependency takes every replica out at once and turns a degraded system
   * into an outage. `/healthz` reports; `/readyz` still answers for the
   * lifecycle alone.
   */
  readonly health: () => AsyncResult<HealthReport, never>;
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
        if (request.url === "/healthz") {
          // The unit of work is the RESPONSE, so the body is written inside
          // the settle — the same obligation a runtime owes, for the same
          // reason: a report computed and not flushed tells nobody anything.
          // The `void` is the third audited dropped-Result exception:
          // `runHealthChecks` recovers every failure AND defect into the
          // report, so the `.map` always runs and nothing observable is lost.
          void args.health().map((report) => {
            response
              .writeHead(report.status === "healthy" ? 200 : 503, {
                "content-type": "application/json",
              })
              .end(JSON.stringify(report));
          });
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
