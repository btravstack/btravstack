import pino from "pino";
import { describe, expect } from "vitest";

import { pinoSink } from "./pino.js";
import { it } from "./test-fixtures.js";

describe("the pino sink", () => {
  it("writes the message and the correlation as fields pino can index", ({ written }) => {
    // GIVEN a pino logger over a stream this spec keeps, at pino's own floor —
    // the level filter is `createLogger`'s, so pino must not add a second one
    const sink = pinoSink(pino({ level: "trace" }, written));

    // WHEN a line written inside a unit reaches it
    sink({
      level: "info",
      message: "order placed",
      attributes: { orderId: "o-1" },
      cause: undefined,
      time: 0,
      unit: { unitId: "u-1", traceId: "t-1" },
    });

    // THEN pino's own line carries every field, and the message where pino
    // puts it
    expect(JSON.parse(written.chunks().join("")) as Record<string, unknown>).toEqual(
      expect.objectContaining({
        msg: "order placed",
        orderId: "o-1",
        unitId: "u-1",
        traceId: "t-1",
      }),
    );
  });

  it("hands a failure to pino as `err`, whose serialiser keeps the stack", ({ written }) => {
    // GIVEN a pino logger and a failure
    const sink = pinoSink(pino({ level: "trace" }, written));

    // WHEN an error line reaches it
    sink({
      level: "error",
      message: "could not save",
      attributes: {},
      cause: new Error("the database is on fire"),
      time: 0,
      unit: undefined,
    });

    // THEN the parts a bare JSON.stringify drops are on the line
    expect(
      (JSON.parse(written.chunks().join("")) as { readonly err: Record<string, unknown> }).err,
    ).toEqual(
      expect.objectContaining({
        type: "Error",
        message: "the database is on fire",
        stack: expect.any(String),
      }),
    );
  });

  it("maps every level onto pino's own, including trace and fatal", ({ written }) => {
    // GIVEN a pino logger keeping everything
    const sink = pinoSink(pino({ level: "trace" }, written));

    // WHEN one line per level is written
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) {
      sink({ level, message: level, attributes: {}, cause: undefined, time: 0, unit: undefined });
    }

    // THEN pino recorded each at its own numeric severity — no level of ours
    // silently collapses into another
    expect(
      written
        .chunks()
        .join("")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { readonly level: number }).level),
    ).toEqual([10, 20, 30, 40, 50, 60]);
  });
});
