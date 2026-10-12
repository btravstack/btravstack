import { TaggedError } from "unthrown";
import { describe, expect, vi } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { jsonSink } from "./json-sink.js";

const lineOf = (written: { readonly chunks: () => readonly string[] }): Record<string, unknown> =>
  JSON.parse(written.chunks().join("")) as Record<string, unknown>;

describe("the JSON sink", () => {
  it("keeps bounded aggregate constituents, including their nested causes", ({ written }) => {
    // GIVEN the original failure and a failure of its observer
    const cause = new AggregateError(
      [
        new Error("observer failed"),
        new Error("operation failed", { cause: new Error("connection refused") }),
        ...Array.from({ length: 20 }, () => new Error("additional")),
      ],
      "both failures",
    );

    // WHEN the diagnostic line is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });
    const rendered = lineOf(written)["cause"] as { errors: unknown[]; omittedErrors: number };

    // THEN both failures survive, and the aggregate's width is bounded
    expect(rendered).toEqual(
      expect.objectContaining({
        errors: [
          expect.objectContaining({ message: "observer failed" }),
          expect.objectContaining({
            message: "operation failed",
            cause: expect.objectContaining({ message: "connection refused" }),
          }),
          ...Array.from({ length: 14 }, () => expect.objectContaining({ message: "additional" })),
        ],
        omittedErrors: 6,
      }),
    );
  });

  it("redacts object-valued aggregate members without running their serializers", ({ written }) => {
    // GIVEN rejection reasons that carry private data
    const cause = new AggregateError(
      [
        { token: "private-token", user: { email: "private@example.test" } },
        ["private-token"],
        { toJSON: () => "private-token" },
        () => "private-token",
        new Error("wrapped", { cause: { token: "private-token" } }),
        "refused",
        42,
        false,
        null,
      ],
      "failed batch",
    );

    // WHEN the diagnostic line is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN private payloads are replaced while error and scalar diagnostics survive
    expect(lineOf(written)["cause"]).toEqual({
      name: "AggregateError",
      message: "failed batch",
      stack: expect.any(String),
      errors: [
        "[non-error]",
        "[non-error]",
        "[non-error]",
        "[non-error]",
        expect.objectContaining({ message: "wrapped", cause: "[non-error]" }),
        "refused",
        42,
        false,
        null,
      ],
    });
  });

  it("keeps sibling diagnostics when aggregate members contain BigInt reasons", ({ written }) => {
    // GIVEN a legal rejection reason that JSON cannot encode
    const cause = new AggregateError(
      [
        1n,
        new Error("operation failed"),
        new AggregateError([2n, new Error("observer failed")], "nested"),
        new Error("wrapped", { cause: 3n }),
      ],
      "failed batch",
    );

    // WHEN the diagnostic line is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN only the unsupported reasons are replaced, preserving the whole error tree
    expect(lineOf(written)["cause"]).toEqual({
      name: "AggregateError",
      message: "failed batch",
      stack: expect.any(String),
      errors: [
        "[non-error]",
        expect.objectContaining({ message: "operation failed" }),
        expect.objectContaining({
          message: "nested",
          errors: ["[non-error]", expect.objectContaining({ message: "observer failed" })],
        }),
        expect.objectContaining({ message: "wrapped", cause: "[non-error]" }),
      ],
    });
  });

  it("keeps aggregate diagnostics without invoking an errors accessor", ({ written }) => {
    // GIVEN a dependency error whose member accessor throws
    const cause = new AggregateError([], "failed batch");
    Object.defineProperty(cause, "errors", { get: () => JSON.parse("broken accessor") });

    // WHEN the diagnostic line is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN the error's diagnostic survives and the accessor is never executed
    expect(lineOf(written)["cause"]).toEqual({
      name: "AggregateError",
      message: "failed batch",
      stack: expect.any(String),
    });
  });

  for (const errors of [undefined, null, "invalid", { token: "private-token" }]) {
    it(`keeps the diagnostic when aggregate errors is ${JSON.stringify(errors)}`, ({ written }) => {
      // GIVEN an aggregate whose writable errors property is malformed
      const cause = new AggregateError([], "failed batch");
      Object.defineProperty(cause, "errors", { value: errors });

      // WHEN the diagnostic line is rendered
      jsonSink(written)({
        level: "error",
        message: "failed",
        attributes: {},
        cause,
        time: 0,
        unit: undefined,
      });

      // THEN the aggregate's own diagnostic survives without malformed members
      expect(lineOf(written)["cause"]).toEqual({
        name: "AggregateError",
        message: "failed batch",
        stack: expect.any(String),
      });
    });
  }

  it("keeps a tagged error's identity without copying its secret-bearing payload", ({
    written,
  }) => {
    // GIVEN a tagged error carrying private context
    class Refused extends TaggedError("Refused")<{ token: string; actor: string }> {}
    const cause = new Refused({ token: "private-token", actor: "private@example.test" });

    // WHEN the diagnostic line is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN its tag survives, and arbitrary payload fields do not
    expect(lineOf(written)["cause"]).toEqual({
      name: "Refused",
      message: cause.message,
      stack: expect.any(String),
      _tag: "Refused",
    });
  });

  it("keeps only safe scalar infrastructure diagnostics from a tagged error", ({ written }) => {
    // GIVEN database diagnostics alongside private request context
    class DatabaseFailed extends TaggedError("DatabaseFailed")<{
      sqlState: string;
      constraint: string;
      table: string;
      database: string;
      role: string;
      bypass: boolean;
      port: number;
      token: string;
      issues: unknown[];
    }> {}
    const cause = new DatabaseFailed({
      sqlState: "23505",
      constraint: "unique_id",
      table: "orders",
      database: "app",
      role: "app_role",
      bypass: false,
      port: 5432,
      token: "secret",
      issues: [{ message: "private" }],
    });

    // WHEN it is written
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN the fixed scalar whitelist keeps diagnostics without arbitrary payloads
    expect(lineOf(written)["cause"]).toEqual({
      name: "DatabaseFailed",
      message: cause.message,
      stack: expect.any(String),
      _tag: "DatabaseFailed",
      sqlState: "23505",
      constraint: "unique_id",
      table: "orders",
      database: "app",
      role: "app_role",
      bypass: false,
      port: 5432,
    });
  });

  it("bounds cycles through aggregate members and causes without losing the line", ({
    written,
  }) => {
    // GIVEN an aggregate referring to itself through both error channels
    const cause = new AggregateError([], "recursive");
    cause.errors.push(cause);
    cause.cause = cause;

    // WHEN it is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN the diagnostic remains useful and cannot recurse forever
    expect(lineOf(written)["cause"]).toEqual({
      name: "AggregateError",
      message: "recursive",
      stack: expect.any(String),
      errors: ["[circular]"],
      cause: "[circular]",
    });
  });

  it("bounds nested aggregates at the same depth as cause chains", ({ written }) => {
    // GIVEN a tree deeper than the renderer permits
    let cause: Error = new Error("too deep");
    for (let i = 0; i < 6; i++) cause = new AggregateError([cause], "nested");

    // WHEN it is rendered
    jsonSink(written)({
      level: "error",
      message: "failed",
      attributes: {},
      cause,
      time: 0,
      unit: undefined,
    });

    // THEN no deeply nested payload survives the bound
    expect(written.chunks().join("")).not.toContain("too deep");
  });

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
      unserialisable: ["cause"],
    });
  });

  it("names the attribute that could not be serialised, and keeps the rest", ({ written }) => {
    // GIVEN a BigInt attribute — what `JSON.stringify` refuses — inside a unit
    jsonSink(written)({
      level: "info",
      message: "counted",
      attributes: { orderId: "o-1", total: 10n as never },
      cause: undefined,
      time: 0,
      unit: { unitId: "u-1", traceId: "t-1" },
    });

    // WHEN the line is read back
    // THEN only the culprit is dropped, and it is the one named
    expect(lineOf(written)).toEqual({
      orderId: "o-1",
      time: "1970-01-01T00:00:00.000Z",
      level: "info",
      message: "counted",
      unitId: "u-1",
      traceId: "t-1",
      unserialisable: ["total"],
    });
  });

  it("tests a field under its own key, so a key-dependent toJSON cannot cost the line", ({
    written,
  }) => {
    // GIVEN a cause whose toJSON refuses only when rendered as `cause`
    const keyed = {
      toJSON: (key: string) => {
        // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a toJSON that throws for one property key only
        if (key === "cause") throw new Error("not as a cause");
        return "fine elsewhere";
      },
    };

    // WHEN it is written
    jsonSink(written)({
      level: "warn",
      message: "kept",
      attributes: {},
      cause: keyed,
      time: 0,
      unit: { unitId: "u-1", traceId: "t-1" },
    });

    // THEN the line is written with the culprit named, rather than lost
    expect(written.chunks().map((chunk) => JSON.parse(chunk) as unknown)).toEqual([
      {
        time: "1970-01-01T00:00:00.000Z",
        level: "warn",
        message: "kept",
        unitId: "u-1",
        traceId: "t-1",
        unserialisable: ["cause"],
      },
    ]);
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
