import { Module, Provider } from "@btravstack/di";
import { it } from "@btravstack/internal-http-fixtures";
import {
  createLogger,
  diagnosticPolicy,
  jsonSink,
  kernelEvents,
  observability,
} from "@btravstack/observability";
import { describe, expect } from "vitest";

import { HttpHandler } from "./handler.js";
import { HttpRuntime, httpServer } from "./http-runtime.js";

describe("HTTP diagnostic disclosure", () => {
  it.for([
    {
      name: "opaque",
      requestId: "0192b5b0-0000-7000-8000-000000000001",
      expected: "0192b5b0-0000-7000-8000-000000000001",
    },
    { name: "personal", requestId: "Synthetic.Person.716", expected: "[redacted]" },
  ])(
    "minimizes actual HTTP and process output with $name correlation",
    async ({ requestId, expected }, { boot }) => {
      // GIVEN
      const written: string[] = [];
      const stream = { write: (line: string) => written.push(line) };
      const diagnostics = diagnosticPolicy({
        messages: ["http.request failed"],
        fields: { method: ["GET"], status: { min: 100, max: 599 }, event: ["uncaught"] },
      });
      const cause = new Error("http@example.invalid", {
        cause: new Error("nested@example.invalid"),
      });
      Object.assign(cause, { attached: "payload@example.invalid" });
      const graph = Module("DiagnosticHttp")({
        imports: [
          httpServer({ port: 0, hostname: "127.0.0.1" }),
          observability({ diagnostics, sink: jsonSink(stream) }),
        ],
        provides: [
          Provider.member(HttpHandler)({
            inject: {},
            value: { prefix: "/", handle: () => Promise.reject(cause) },
          }),
        ],
        exports: [HttpRuntime, HttpHandler],
      });
      const app = boot(graph, {
        onEvent: kernelEvents(createLogger(jsonSink(stream), "trace", diagnostics)),
      });
      // WHEN
      const info = (await app.runtimeInfo()).get()!;
      const response = await fetch(`http://127.0.0.1:${info.port}/`, {
        headers: { "x-request-id": requestId },
      });
      await response.arrayBuffer();
      kernelEvents(createLogger(jsonSink(stream), "trace", diagnostics))({
        type: "uncaught",
        cause,
      });
      app.stop();
      await app.exited;
      // THEN
      expect({
        status: response.status,
        leaked:
          written.join("").includes("@example.invalid") ||
          written.join("").includes("Synthetic.Person.716"),
        lines: written.map((line) => JSON.parse(line) as unknown),
        original: cause.message,
      }).toEqual({
        status: 500,
        leaked: false,
        lines: expect.arrayContaining([
          expect.objectContaining({
            message: "http.request failed",
            traceId: expected,
          }),
          expect.objectContaining({ event: "uncaught", cause: { code: "unknown" } }),
        ]),
        original: "http@example.invalid",
      });
    },
  );
});
