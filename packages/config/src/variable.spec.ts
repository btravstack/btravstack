import { describe, expect, it } from "vitest";

import { assertValidPrefix, variableName } from "./variable.js";

describe("assertValidPrefix", () => {
  it("rejects a prefix that is not upper-snake-case", () => {
    // GIVEN a lowercase prefix — `amqp_URL` is a variable nobody will set
    // WHEN the prefix is checked
    // THEN the mistake is caught, not silently accepted
    expect(() => assertValidPrefix("amqp")).toThrow(/upper-snake-case/);
  });

  it("accepts an upper-snake-case prefix", () => {
    // GIVEN a properly shouted prefix
    // WHEN the prefix is checked
    // THEN nothing is thrown
    expect(() => assertValidPrefix("AMQP")).not.toThrow();
  });
});

describe("variableName", () => {
  it("joins the prefix to a screaming-snake key", () => {
    // GIVEN a slice prefix and a camelCase key
    // WHEN the environment variable name is derived
    // THEN it is the shouted form the environment actually uses
    expect(variableName("AMQP", "url")).toBe("AMQP_URL");
  });

  it("splits camelCase into words", () => {
    // GIVEN a multi-word key
    // WHEN the name is derived
    // THEN each word boundary becomes an underscore
    expect(variableName("AMQP", "prefetchCount")).toBe("AMQP_PREFETCH_COUNT");
  });

  it("keeps digits attached to the word they follow", () => {
    // GIVEN a key with a trailing number
    // WHEN the name is derived
    // THEN the digit does not become a word of its own
    expect(variableName("HTTP", "port2")).toBe("HTTP_PORT2");
  });
});
