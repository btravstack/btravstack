import { describe, expect, test } from "vitest";
import { z } from "zod";

import { Temporal, calendarDate, instant } from "./__tests__/temporal.js";
import { Entity } from "./index.js";

describe("Entity.codec in a JSON contract", () => {
  test.each(["input", "output"] as const)(
    "publishes nested native calendar dates and instants as wire strings for %s",
    (direction) => {
      // GIVEN
      const schema = z.object({
        schedule: z.object({
          date: calendarDate.describe("Calendar date"),
          at: instant.meta({ description: "Scheduled instant" }),
          alternatives: z.array(calendarDate.nullable()).optional(),
        }),
      });

      // WHEN
      const document = schema["~standard"].jsonSchema[direction]({ target: "draft-2020-12" });

      // THEN
      expect(document).toMatchObject({
        type: "object",
        properties: {
          schedule: {
            type: "object",
            properties: {
              date: { type: "string", format: "date", description: "Calendar date" },
              at: { type: "string", format: "date-time", description: "Scheduled instant" },
              alternatives: {
                type: "array",
                items: { anyOf: [{ type: "string", format: "date" }, { type: "null" }] },
              },
            },
            required: ["date", "at"],
          },
        },
        required: ["schedule"],
      });
    },
  );

  test("keeps native decoding, decoded-value acceptance and canonical encoding", () => {
    // GIVEN
    const schema = z.object({ date: calendarDate, at: instant });
    const wire = { date: "2026-11-05", at: "2026-11-05T12:30:00Z" };

    // WHEN
    const decoded = schema.parse(wire);
    const reparsed = schema.parse(decoded);
    const encoded = z.encode(schema, reparsed);
    const invalid = schema.safeParse({ date: "2026-02-30", at: wire.at });

    // THEN
    expect({
      date: decoded.date instanceof Temporal.PlainDate,
      instant: decoded.at instanceof Temporal.Instant,
      reparsedDate: reparsed.date.toString(),
      encoded,
      invalid: invalid.success,
    }).toEqual({
      date: true,
      instant: true,
      reparsedDate: wire.date,
      encoded: wire,
      invalid: false,
    });
  });

  test("keeps recursive wire references in the containing schema's definitions", () => {
    // GIVEN
    const node = z.object({
      value: z.string(),
      get children() {
        return z.array(node);
      },
    });
    const wrapped = Entity.codec(
      node,
      z.custom<URL>((value) => value instanceof URL),
      {
        decode: (value) => new URL(value.value),
        encode: (value) => ({ value: value.href, children: [] }),
      },
    );
    const schema = z.object({ tree: wrapped });

    // WHEN
    const document = z.toJSONSchema(schema);

    // THEN
    expect(document).toMatchObject({
      properties: { tree: { $ref: "#/$defs/__schema0" } },
      $defs: {
        __schema0: {
          type: "object",
          properties: {
            value: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/__schema0" } },
          },
        },
      },
    });
  });
});
