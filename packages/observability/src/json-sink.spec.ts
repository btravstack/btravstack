import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { jsonSink } from "./json-sink.js";

const lineOf = (written: { readonly chunks: () => readonly string[] }): Record<string, unknown> =>
  JSON.parse(written.chunks().join("")) as Record<string, unknown>;

describe("the JSON sink", () => {
  it("writes one object per line, correlation fields at the top level", ({ written }) => {
    // GIVEN a sink over a stream that keeps what it is given
    const sink = jsonSink(written);

    // WHEN a line written inside a unit reaches it
    sink({
      level: "info",
      message: "order placed",
      attributes: { orderId: "o-1" },
      cause: undefined,
      time: Date.UTC(2026, 7, 16),
      unit: { unitId: "u-1", traceId: "t-1", tenantId: "acme" },
    });

    // THEN the ids are fields an operator can search, not a message prefix
    expect({ line: lineOf(written), newline: written.chunks().join("").endsWith("\n") }).toEqual({
      line: {
        time: "2026-08-16T00:00:00.000Z",
        level: "info",
        message: "order placed",
        orderId: "o-1",
        unitId: "u-1",
        traceId: "t-1",
        tenantId: "acme",
      },
      newline: true,
    });
  });

  it("keeps an Error's message and stack, which JSON.stringify drops", ({ written }) => {
    // GIVEN a failure wrapping another
    const cause = new Error("could not connect", { cause: new Error("ECONNREFUSED") });

    // WHEN it is written
    jsonSink(written)({
      level: "error",
      message: "the relay stopped",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN both levels survive, with the parts a bare stringify would lose
    expect(lineOf(written)["cause"]).toEqual({
      name: "Error",
      message: "could not connect",
      stack: expect.stringContaining("could not connect"),
      cause: { name: "Error", message: "ECONNREFUSED", stack: expect.any(String) },
    });
  });

  it("refuses to let a caller's attribute rewrite the severity", ({ written }) => {
    // GIVEN attributes that name the fields the sink owns
    jsonSink(written)({
      level: "error",
      message: "the real message",
      attributes: { level: "info", message: "spoofed", traceId: "forged" },
      cause: undefined,
      time: 0,
      unit: { unitId: "u-1", traceId: "t-1" },
    });

    // WHEN the line is read back
    // THEN the line's own severity, message and correlation won
    expect(lineOf(written)).toEqual(
      expect.objectContaining({ level: "error", message: "the real message", traceId: "t-1" }),
    );
  });

  it("keeps the message when the payload cannot be serialised at all", ({ written }) => {
    // GIVEN a cause that is circular — what `JSON.stringify` refuses outright
    const circular: { self?: unknown } = {};
    circular.self = circular;

    // WHEN it is written
    jsonSink(written)({
      level: "warn",
      message: "kept",
      attributes: {},
      cause: circular,
      time: 0,
      unit: undefined,
    });

    // THEN the line survives without the part that could not be rendered,
    // rather than the sink throwing and the line being lost entirely
    expect(lineOf(written)).toEqual({
      time: "1970-01-01T00:00:00.000Z",
      level: "warn",
      message: "kept",
      cause: "[unserialisable]",
    });
  });

  it("defaults to stdout, so a process that configures nothing still logs", () => {
    // GIVEN the sink with no stream given, and stdout captured
    const written = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    // WHEN a line is written
    jsonSink()({
      level: "info",
      message: "to stdout",
      attributes: {},
      cause: undefined,
      time: 0,
      unit: undefined,
    });
    // Captured before the spy is restored: `mockRestore` clears the record
    // along with the stub.
    const chunk = written.mock.calls.at(0)?.at(0);
    written.mockRestore();

    // THEN it went to the process's own stream — logs are stdout by default,
    // where a container runtime already collects them
    expect(chunk).toBe(
      `${JSON.stringify({ time: "1970-01-01T00:00:00.000Z", level: "info", message: "to stdout" })}\n`,
    );
  });
});
