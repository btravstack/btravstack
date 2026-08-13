import { describe, expect, it } from "vitest";

import { readEnv } from "./env.js";

// The seven cases the shared fragments have to survive are pinned once, in
// `order-config`. What is this deployment's own is which variables it reads,
// what they default to, and that concurrency is bounded differently from a port.
describe("readEnv", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    // GIVEN an environment with neither variable set
    const source = {};

    // WHEN it is validated
    const env = readEnv(source);

    // THEN both carry their defaults: one probe port, one consumer
    expect(env).toBeOkWith({ PROBE_PORT: 9000, CONCURRENCY: 1 });
  });

  it("reads what a deployment actually supplies", () => {
    // GIVEN both set, as the strings an environment always holds
    const source = { PROBE_PORT: "0", CONCURRENCY: "8" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN they arrive parsed, and `0` survives as the ephemeral bind it is
    expect(env).toBeOkWith({ PROBE_PORT: 0, CONCURRENCY: 8 });
  });

  it("refuses a concurrency of zero, which a port's own bounds would allow", () => {
    // GIVEN the one value that is legal for a port and absurd for a worker
    const source = { CONCURRENCY: "0" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN the bound that differs between the two variables is the one doing
    // the work: a worker consuming nothing is a deployment mistake
    expect(env).toBeErrWith([expect.objectContaining({ path: ["CONCURRENCY"] })]);
  });
});
