import { describe, expect, it } from "vitest";

import { readEnv } from "./env.js";

// The seven cases the shared `port` fragment has to survive are pinned once, in
// `order-config`. What is this deployment's own is its one string variable,
// which is not a number and has its own emptiness rule.
describe("readEnv", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    // GIVEN an environment with neither variable set
    const source = {};

    // WHEN it is validated
    const env = readEnv(source);

    // THEN both carry their defaults, the port as a number
    expect(env).toBeOkWith({ PROBE_PORT: 9000, AMQP_URL: "amqp://127.0.0.1:5672" });
  });

  it("reads what a deployment actually supplies", () => {
    // GIVEN both set, as the strings an environment always holds
    const source = { PROBE_PORT: "0", AMQP_URL: "amqp://broker.internal:5672" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN they arrive parsed, and `0` survives as the ephemeral bind it is
    expect(env).toBeOkWith({ PROBE_PORT: 0, AMQP_URL: "amqp://broker.internal:5672" });
  });

  it("rejects a broker URL that is present but empty, rather than defaulting it", () => {
    // GIVEN a URL set to nothing — the string variable's version of the
    // blank-value rule the numeric fragment enforces with `.min(1)` up front
    const source = { AMQP_URL: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN it is a configuration error rather than an absent variable: a
    // worker that silently defaults its broker is a worker consuming nothing
    expect(env).toBeErrWith([expect.objectContaining({ path: ["AMQP_URL"] })]);
  });
});
