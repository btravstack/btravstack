import { Env } from "@btravstack/config";
import { Observers } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import pino from "pino";
import { OkAsync, TaggedError } from "unthrown";
import { describe, expect, test } from "vitest";

import { diagnosticPolicy, sensitiveDiagnostics } from "./diagnostics.js";
import { jsonSink } from "./json-sink.js";
import { createLogger, type Line } from "./logger.js";
import { kernelEvents, observability } from "./observability.js";
import { pinoSink } from "./pino.js";

describe("diagnostic disclosure", () => {
  test("preserves attribute precedence without evaluating ignored or allowed accessors", () => {
    // GIVEN
    const lines: Line[] = [];
    let reads = 0;
    const getter = () => {
      reads += 1;
      // oxlint-disable-next-line unthrown/no-throw -- protected logging must never invoke attribute getters
      throw new Error("accessor must not run");
    };
    const diagnostics = diagnosticPolicy({
      messages: ["failed"],
      fields: { attempt: { min: 0, max: 3 }, phase: ["opening", "closing"] },
    });
    const logger = createLogger((line) => lines.push(line), "trace", diagnostics);
    const base = Object.defineProperties(
      { attempt: 1, phase: "opening" },
      {
        secret: { enumerable: true, get: getter },
        hidden: { enumerable: false, get: getter },
      },
    );

    // WHEN
    const child = logger.with(base).with({ phase: "closing" });
    child.error("failed", {
      attempt: 2,
      get secret(): never {
        return getter();
      },
    });
    child.error("failed", { attempt: 4 });
    child.error("failed", {
      get attempt() {
        return getter();
      },
    });
    child.error("failed");
    logger.error("failed");

    // THEN
    expect({ reads, lines: lines.map(({ attributes }) => attributes) }).toEqual({
      reads: 0,
      lines: [
        { attempt: 2, phase: "closing" },
        { phase: "closing" },
        { phase: "closing" },
        { attempt: 1, phase: "closing" },
        {},
      ],
    });
  });

  test("filters process serving info and observed layers before invoking accessors", async () => {
    // GIVEN
    const lines: Line[] = [];
    let reads = 0;
    const attributes = {
      attempt: 1,
      get secret(): never {
        reads += 1;
        // oxlint-disable-next-line unthrown/no-throw -- an ignored attribute getter must not run in either adapter
        throw new Error("accessor must not run");
      },
    };
    const diagnostics = diagnosticPolicy({ fields: { attempt: { min: 0, max: 3 } } });
    const logger = createLogger((line) => lines.push(line), "trace", diagnostics);
    const App = Module("ProtectedObservations")({
      imports: [
        observability({ diagnostics, sink: (line) => lines.push(line), level: "trace" }),
        Module("DiagnosticEnv")({
          provides: [Provider(Env)({ inject: {}, value: {} })],
          exports: [Env],
        }),
      ],
      exports: [Observers],
    });

    // WHEN
    kernelEvents(logger)({ type: "serving", runtime: "test", info: attributes, probePort: 0 });
    const result = await Module.scoped(App, (ctx) => {
      for (const observer of ctx.get(Observers)) {
        observer({ component: "cache", name: "get", attributes, details: { attempt: 2 } })({
          outcome: "error",
          attributes: { attempt: 3 },
        });
      }
      return OkAsync();
    });

    // THEN
    expect({ reads, result, lines: lines.map(({ attributes: fields }) => fields) }).toEqual({
      reads: 0,
      result: expect.toBeOk(),
      lines: [{ attempt: 1 }, { attempt: 3 }],
    });
  });

  test.each([
    { min: Infinity, max: 3 },
    { min: 0, max: Infinity },
    { min: 3, max: 0 },
  ])("omits a numeric field with invalid bounds %j", (rule) => {
    // GIVEN
    const diagnostics = diagnosticPolicy({ fields: { attempt: rule } });
    // WHEN
    const rendered = diagnostics.attributes({ attempt: 1 });
    // THEN
    expect(rendered).toEqual({});
  });
  test("keeps only static vocabulary and bounded numeric fields without reading accessors", () => {
    // GIVEN
    const diagnostics = diagnosticPolicy({
      messages: ["failed"],
      codes: ["Unavailable"],
      fields: { attempt: { min: 0, max: 3 }, phase: ["opening"], retryable: [true] },
    });
    class Unavailable extends TaggedError("Unavailable")<{ attempt: number; secret: string }> {}
    const cause = new Unavailable({ attempt: 2, secret: "synthetic@example.invalid" });
    Object.defineProperty(cause, "phase", {
      get: () => {
        // oxlint-disable-next-line unthrown/no-throw -- an accessor must never run while rendering diagnostics
        throw new Error("accessor must not run");
      },
    });
    // WHEN
    const rendered = diagnostics.cause(cause);
    const fields = diagnostics.attributes({
      attempt: 4,
      phase: "opening",
      retryable: true,
      secret: cause.secret,
    });
    // THEN
    expect({
      rendered,
      fields,
      allowed: diagnostics.message("failed"),
      unknown: diagnostics.message(cause.secret),
      empty: diagnosticPolicy().cause(null),
      noFields: diagnosticPolicy().attributes({}),
      invalid: diagnostics.attributes({ attempt: Number.NaN, phase: "other", retryable: false }),
      below: diagnostics.attributes({ attempt: -1 }),
      coded: diagnostics.cause({ code: "Unavailable", attempt: 1 }),
    }).toEqual({
      rendered: { code: "Unavailable", attempt: 2 },
      fields: { phase: "opening", retryable: true },
      allowed: "failed",
      unknown: "diagnostic",
      empty: { code: "unknown" },
      noFields: {},
      invalid: {},
      below: {},
      coded: { code: "Unavailable", attempt: 1 },
    });
  });

  test("protects process events and observer lines before a custom sink sees them", () => {
    // GIVEN
    const lines: Line[] = [];
    const diagnostics = diagnosticPolicy({ fields: { event: ["uncaught"] } });
    const logger = createLogger((line) => lines.push(line), "trace", diagnostics);
    const cause = new Error("synthetic@example.invalid", {
      cause: new Error("nested@example.invalid"),
    });
    // WHEN
    kernelEvents(logger)({ type: "uncaught", cause });
    logger.with({ secret: "attached@example.invalid" }).error("person@example.invalid", {}, cause);
    // THEN
    expect({
      original: cause.message,
      lines: lines.map(({ message, attributes, cause: failure }) => ({
        message,
        attributes,
        cause: failure,
      })),
    }).toEqual({
      original: "synthetic@example.invalid",
      lines: [
        { message: "diagnostic", attributes: { event: "uncaught" }, cause: { code: "unknown" } },
        { message: "diagnostic", attributes: {}, cause: { code: "unknown" } },
      ],
    });
  });

  test.each(["json", "pino"] as const)(
    "applies the production boundary to the direct %s sink",
    (kind) => {
      // GIVEN
      const chunks: string[] = [];
      const stream = { write: (chunk: string) => chunks.push(chunk) };
      const diagnostics = diagnosticPolicy({ messages: ["failed"] });
      const line: Line = {
        level: "error",
        message: "failed",
        attributes: { secret: "field@example.invalid" },
        cause: new Error("top@example.invalid", { cause: new Error("nested@example.invalid") }),
        time: 0,
        unit: { unitId: "u", traceId: "t" },
      };
      // WHEN
      const sink =
        kind === "json"
          ? jsonSink(stream, diagnostics)
          : pinoSink(pino({ timestamp: false }, stream), diagnostics);
      sink(line);
      // THEN
      expect({
        leaked: chunks.join("").includes("@example.invalid"),
        lines: chunks.map((chunk) => JSON.parse(chunk) as unknown),
      }).toEqual({
        leaked: false,
        lines: [
          expect.objectContaining({
            [kind === "json" ? "message" : "msg"]: "failed",
            traceId: "t",
            unitId: "u",
            [kind === "json" ? "cause" : "err"]: { code: "unknown" },
          }),
        ],
      });
    },
  );

  test("makes sensitive debugging an explicit policy choice", () => {
    // GIVEN
    const chunks: string[] = [];
    const cause = new Error("debug@example.invalid");
    // WHEN
    const logger = createLogger(
      jsonSink({ write: (chunk) => chunks.push(chunk) }),
      "debug",
      sensitiveDiagnostics,
    );
    logger.error("debug", { detail: "kept" }, cause);
    // THEN
    expect({
      output: chunks.map((chunk) => JSON.parse(chunk) as unknown),
      original: sensitiveDiagnostics.cause(cause) === cause,
    }).toEqual({
      output: [
        expect.objectContaining({
          message: "debug",
          detail: "kept",
          cause: expect.objectContaining({ message: cause.message }),
        }),
      ],
      original: true,
    });
  });

  test("drops properties a hostile proxy refuses to disclose", () => {
    // GIVEN
    const cause = new Proxy(
      {},
      {
        getOwnPropertyDescriptor: () => {
          // oxlint-disable-next-line unthrown/no-throw -- exercises an adversarial reflection trap
          throw new Error("secret@example.invalid");
        },
      },
    );
    const diagnostics = diagnosticPolicy({ fields: { attempt: { min: 0, max: 3 } } });
    // WHEN
    const rendered = diagnostics.cause(cause);
    // THEN
    expect(rendered).toEqual({ code: "unknown" });
  });
});
