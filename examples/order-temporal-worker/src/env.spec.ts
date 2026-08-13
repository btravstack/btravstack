import { describe, expect, it } from "vitest";

import { readEnv } from "./env.js";

// The seven cases the shared `port` fragment has to survive are pinned once, in
// `order-config`. What is this deployment's own is its two string variables,
// which are not numbers and have their own emptiness rule.
describe("readEnv", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    // GIVEN an environment with none of the three variables set
    const source = {};

    // WHEN it is validated
    const env = readEnv(source);

    // THEN all three carry their defaults, the port as a number
    expect(env).toBeOkWith({
      PROBE_PORT: 9000,
      TEMPORAL_ADDRESS: "127.0.0.1:7233",
      TEMPORAL_NAMESPACE: "default",
    });
  });

  it("reads what a deployment actually supplies", () => {
    // GIVEN all three set, as the strings an environment always holds
    const source = {
      PROBE_PORT: "0",
      TEMPORAL_ADDRESS: "temporal.internal:7233",
      TEMPORAL_NAMESPACE: "orders",
    };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN they arrive parsed, and `0` survives as the ephemeral bind it is
    expect(env).toBeOkWith({
      PROBE_PORT: 0,
      TEMPORAL_ADDRESS: "temporal.internal:7233",
      TEMPORAL_NAMESPACE: "orders",
    });
  });

  it("rejects a namespace that is present but empty, rather than defaulting it", () => {
    // GIVEN a namespace set to nothing — the string variables' version of the
    // blank-value rule the numeric fragment enforces with `.min(1)` up front
    const source = { TEMPORAL_NAMESPACE: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN it is a configuration error rather than an absent variable: polling
    // the wrong namespace is a worker that silently receives nothing
    expect(env).toBeErrWith([expect.objectContaining({ path: ["TEMPORAL_NAMESPACE"] })]);
  });
});
