import { fromSchema } from "@unthrown/standard-schema";
import { describe, expect, it } from "vitest";

import { port, wholeNumber } from "./zod.js";

describe("wholeNumber", () => {
  const parse = fromSchema(wholeNumber(10, 1, 100));

  it("defaults when the variable is absent", () => {
    // GIVEN nothing set
    // WHEN parsed
    // THEN the fallback stands in
    expect(parse(undefined)).toBeOkWith(10);
  });

  it("rejects a present-but-empty value rather than defaulting it", () => {
    // GIVEN `VAR=` — set, but to nothing
    // WHEN parsed
    // THEN it is a configuration error: `Number("")` is `0`, and a silent `0`
    // is the bug this guard exists to prevent
    expect(parse("")).toBeErr();
  });

  it("rejects a non-number, a fraction, and an out-of-range value", () => {
    // GIVEN values the bounds must catch
    // WHEN parsed
    // THEN each is an error
    expect(parse("abc")).toBeErr();
    expect(parse("3.5")).toBeErr();
    expect(parse("101")).toBeErr();
  });

  it("accepts a whole number in range", () => {
    // GIVEN a good value, as a string — the only thing an environment holds
    // WHEN parsed
    // THEN it arrives as a number
    expect(parse("42")).toBeOkWith(42);
  });
});

describe("port", () => {
  it("allows 0, the ephemeral bind", () => {
    // GIVEN `PORT=0`
    // WHEN parsed
    // THEN it survives: a port's `min` IS `0`, which is why the empty-string
    // guard cannot be left to the bounds
    expect(fromSchema(port(3000))("0")).toBeOkWith(0);
  });
});
