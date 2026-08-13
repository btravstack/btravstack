import { describe, expect, it } from "vitest";

import { readEnv } from "./env.js";

// The seven cases the shared `port` fragment has to survive are pinned once, in
// `order-config`. What is this deployment's own is which variables it reads and
// what they default to.
describe("readEnv", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    // GIVEN an environment with neither port set
    const source = {};

    // WHEN it is validated
    const env = readEnv(source);

    // THEN both ports carry their defaults, as numbers
    expect(env).toBeOkWith({ PORT: 3000, PROBE_PORT: 9000 });
  });

  it("reads the ports a deployment actually supplies", () => {
    // GIVEN both ports set, as the strings an environment always holds
    const source = { PORT: "8080", PROBE_PORT: "0" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN they arrive parsed, and `0` survives as the ephemeral bind it is
    expect(env).toBeOkWith({ PORT: 8080, PROBE_PORT: 0 });
  });

  it("reports every malformed port at once rather than binding NaN", () => {
    // GIVEN the values `Number()` would silently turn into `NaN` and `0`
    const source = { PORT: "abc", PROBE_PORT: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN neither reaches a socket: both are issues in the error channel,
    // named and in order, asserted on the `Err` itself rather than behind an
    // `env.isErr() &&` guard that evaluates to `false` when it does not hold
    expect(env).toBeErrWith([
      expect.objectContaining({ path: ["PORT"] }),
      expect.objectContaining({ path: ["PROBE_PORT"] }),
    ]);
  });
});
