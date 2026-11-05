import pino from "pino";
import { TaggedError } from "unthrown";
import { describe, expect, test } from "vitest";

import { diagnosticPolicy, sensitiveDiagnostics } from "./diagnostics.js";
import { jsonSink } from "./json-sink.js";
import { createLogger, type Line } from "./logger.js";
import { kernelEvents } from "./observability.js";
import { pinoSink } from "./pino.js";

describe("diagnostic disclosure", () => {
  test.each([
    { min: Infinity, max: 3 },
    { min: 0, max: Infinity },
    { min: 3, max: 0 },
  ])("omits a numeric field with invalid bounds %j", (rule) => {
    // Arrange
    const diagnostics = diagnosticPolicy({ fields: { attempt: rule } });
    // Act
    const rendered = diagnostics.attributes({ attempt: 1 });
    // Assert
    expect(rendered).toEqual({});
  });
  test("keeps only static vocabulary and bounded numeric fields without reading accessors", () => {
    // Arrange
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
    // Act
    const rendered = diagnostics.cause(cause);
    const fields = diagnostics.attributes({
      attempt: 4,
      phase: "opening",
      retryable: true,
      secret: cause.secret,
    });
    // Assert
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
    // Arrange
    const lines: Line[] = [];
    const diagnostics = diagnosticPolicy({ fields: { event: ["uncaught"] } });
    const logger = createLogger((line) => lines.push(line), "trace", diagnostics);
    const cause = new Error("synthetic@example.invalid", {
      cause: new Error("nested@example.invalid"),
    });
    // Act
    kernelEvents(logger)({ type: "uncaught", cause });
    logger.with({ secret: "attached@example.invalid" }).error("person@example.invalid", {}, cause);
    // Assert
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
      // Arrange
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
      // Act
      const sink =
        kind === "json"
          ? jsonSink(stream, diagnostics)
          : pinoSink(pino({ timestamp: false }, stream), diagnostics);
      sink(line);
      // Assert
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
    // Arrange
    const chunks: string[] = [];
    const cause = new Error("debug@example.invalid");
    // Act
    const logger = createLogger(
      jsonSink({ write: (chunk) => chunks.push(chunk) }),
      "debug",
      sensitiveDiagnostics,
    );
    logger.error("debug", { detail: "kept" }, cause);
    // Assert
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
    // Arrange
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
    // Act
    const rendered = diagnostics.cause(cause);
    // Assert
    expect(rendered).toEqual({ code: "unknown" });
  });
});
