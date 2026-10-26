import { oc, type, ProcedureContract } from "@orpc/contract";
import { Temporal } from "temporal-polyfill";
import { describe, expect } from "vitest";
import { z } from "zod";

import { it } from "./__tests__/test-fixtures.js";
import { contractInputSchema, contractOutputSchema } from "./orpc.js";

describe("orpc schema accessors", () => {
  it("preserves the input schema's identity", () => {
    // GIVEN
    const schema = z.object({ id: z.string().brand("Id") });
    const procedure = oc.input(schema);

    // WHEN
    const extracted = contractInputSchema(procedure);

    // THEN
    expect(extracted).toBe(schema);
  });

  it("preserves the output schema's identity", () => {
    // GIVEN
    const schema = z.object({ id: z.string().brand("Id") });
    const procedure = oc.output(schema);

    // WHEN
    const extracted = contractOutputSchema(procedure);

    // THEN
    expect(extracted).toBe(schema);
  });

  it("retains input defaults and object composition", () => {
    // GIVEN
    const procedure = oc.input(z.object({ id: z.string(), limit: z.number().default(20) }));

    // WHEN
    const parsed = contractInputSchema(procedure).omit({ id: true }).parse({});

    // THEN
    expect(parsed).toEqual({ limit: 20 });
  });

  it("retains output refinements", () => {
    // GIVEN
    const procedure = oc.output(z.string().refine((value) => value.startsWith("id-")));

    // WHEN
    const parsed = contractOutputSchema(procedure).safeParse("invalid");

    // THEN
    expect(parsed.success).toBe(false);
  });

  it("retains bigint decoding and encoding", () => {
    // GIVEN
    const procedure = oc.input(
      z.codec(z.string().regex(/^\d+$/u), z.bigint(), {
        decode: BigInt,
        encode: String,
      }),
    );

    // WHEN
    const schema = contractInputSchema(procedure);
    const decoded = schema.parse("9007199254740993");
    const encoded = z.encode(schema, decoded);

    // THEN
    expect({ decoded, encoded }).toEqual({
      decoded: 9007199254740993n,
      encoded: "9007199254740993",
    });
  });

  it("retains Temporal codec microseconds", () => {
    // GIVEN
    const procedure = oc.output(
      z.codec(z.iso.datetime(), z.instanceof(Temporal.Instant), {
        decode: Temporal.Instant.from,
        encode: (value) => value.toString(),
      }),
    );
    const wire = "2026-10-26T12:00:00.123456Z";

    // WHEN
    const schema = contractOutputSchema(procedure);
    const decoded = schema.parse(wire);

    // THEN
    expect({ nanoseconds: decoded.epochNanoseconds, encoded: z.encode(schema, decoded) }).toEqual({
      nanoseconds: Temporal.Instant.from(wire).epochNanoseconds,
      encoded: wire,
    });
  });

  it.each([undefined, [], [type<string>()], [z.string(), z.string().min(2)]])(
    "refuses an input schema array that cannot be extracted whole: %j",
    (inputSchemas) => {
      // GIVEN
      const procedure = new ProcedureContract({ inputSchemas, errorMap: {}, meta: {} });

      // WHEN
      const extract = () => contractInputSchema(procedure as never);

      // THEN
      expect(extract).toThrow(z.ZodError);
    },
  );

  it.each([undefined, [], [type<string>()], [z.string(), z.string().min(2)]])(
    "refuses an output schema array that cannot be extracted whole: %j",
    (outputSchemas) => {
      // GIVEN
      const procedure = new ProcedureContract({ outputSchemas, errorMap: {}, meta: {} });

      // WHEN
      const extract = () => contractOutputSchema(procedure as never);

      // THEN
      expect(extract).toThrow(z.ZodError);
    },
  );
});
