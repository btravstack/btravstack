import type { StandardSchemaV1 } from "@standard-schema/spec";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseShape } from "./parse.js";

const shape = {
  url: z.string().min(1).default("amqp://localhost"),
  prefetch: z.string().min(1).pipe(z.coerce.number<string>().int()).default(10),
};

/** A schema whose `validate` crashes rather than reporting an issue. */
const crashingSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: () => {
      // oxlint-disable-next-line unthrown/no-throw -- simulates a third-party Standard Schema whose validate() throws, to exercise the defect path
      throw new Error("schema bug, not a config problem");
    },
  },
};

/** A schema that validates asynchronously — outside what `Shape` can run sync. */
const asyncSchema: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => Promise.resolve({ value: String(value) }),
  },
};

describe("parseShape", () => {
  it("reads each key from its prefixed variable", () => {
    // GIVEN an environment carrying both variables
    const source = { AMQP_URL: "amqp://broker", AMQP_PREFETCH: "32" };

    // WHEN the shape is parsed
    // THEN the value is keyed by the schema's own camelCase names
    expect(parseShape("AMQP", shape, source)).toBeOkWith({
      url: "amqp://broker",
      prefetch: 32,
    });
  });

  it("falls back to the declared defaults when a variable is absent", () => {
    // GIVEN an empty environment
    // WHEN the shape is parsed
    // THEN the starter's own defaults stand in
    expect(parseShape("AMQP", shape, {})).toBeOkWith({
      url: "amqp://localhost",
      prefetch: 10,
    });
  });

  it("labels every issue with the variable an operator must fix", () => {
    // GIVEN two variables that are present but wrong
    const source = { AMQP_URL: "", AMQP_PREFETCH: "abc" };

    // WHEN the shape is parsed
    // THEN both are reported, named as the environment names them — not as
    // the schema's camelCase keys, which no operator can act on
    expect(parseShape("AMQP", shape, source)).toBeErrWith([
      expect.objectContaining({ variable: "AMQP_URL" }),
      expect.objectContaining({ variable: "AMQP_PREFETCH" }),
    ]);
  });

  it("propagates a crash inside validation as a defect, not an issue", () => {
    // GIVEN a schema that crashes rather than reporting an issue — a bug in
    // the schema, not a wrong environment
    // WHEN the shape is parsed
    // THEN the crash is a Defect, not folded into the reported issues
    expect(parseShape("AMQP", { url: crashingSchema }, { AMQP_URL: "x" })).toBeDefect();
  });

  it("returns rather than throws when a schema validates asynchronously", () => {
    // GIVEN a schema outside what a synchronous `Shape` can run — `Shape`'s
    // own type accepts it, but `fromSchema` cannot represent the pending work
    // WHEN the shape is parsed
    // THEN it lands on the defect channel instead of throwing out of parseShape
    expect(() => parseShape("AMQP", { url: asyncSchema }, { AMQP_URL: "x" })).not.toThrow();
    expect(parseShape("AMQP", { url: asyncSchema }, { AMQP_URL: "x" })).toBeDefect();
  });
});
