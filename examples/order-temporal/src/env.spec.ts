import { P } from "unthrown";
import { describe, expect, it } from "vitest";

import { describeEnvIssues, readEnv } from "./env.js";

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

  it("reports a malformed value rather than binding a probe nobody can find", () => {
    // GIVEN the value `Number()` would silently turn into `NaN`, and a
    // namespace that is present but empty
    const source = { PROBE_PORT: "abc", TEMPORAL_NAMESPACE: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN neither reaches the runtime: both are issues in the error channel,
    // named and in order, asserted on the `Err` itself rather than behind an
    // `env.isErr() &&` guard that evaluates to `false` when it does not hold
    expect(env).toBeErrWith([
      expect.objectContaining({ path: ["PROBE_PORT"] }),
      expect.objectContaining({ path: ["TEMPORAL_NAMESPACE"] }),
    ]);
  });

  it("rejects a probe port that is present but empty, rather than defaulting it", () => {
    // GIVEN the variable set to nothing — `Number("")` is `0`, which `min(0)`
    // cannot catch because an ephemeral bind is legal
    const source = { PROBE_PORT: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN it is a configuration error rather than an absent variable: the
    // default is for a variable nobody set, not one set to nothing
    expect(env).toBeErrWith([expect.objectContaining({ path: ["PROBE_PORT"] })]);
  });

  it("rejects a probe port that is present but blank", () => {
    // GIVEN whitespace, which `Number()` reads as `0` just as readily
    const source = { PROBE_PORT: "   " };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN the guard trims before it measures, so this is the empty case
    expect(env).toBeErrWith([expect.objectContaining({ path: ["PROBE_PORT"] })]);
  });

  it("rejects a probe port that is a number but not a whole one", () => {
    // GIVEN a value `Number()` reads happily and no socket could ever bind
    const source = { PROBE_PORT: "3.5" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN it is an issue rather than a silent truncation
    expect(env).toBeErrWith([expect.objectContaining({ path: ["PROBE_PORT"] })]);
  });

  it("rejects a port number no socket could ever bind", () => {
    // GIVEN a number that parses but that nothing could listen on
    const source = { PROBE_PORT: "70000" };

    // WHEN its error channel is folded into the message a deployment reads
    const described = readEnv(source).match({
      ok: () => "WRONGLY ACCEPTED",
      // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is one type (the schema's list of issues), not a union of cases to enumerate
      errCases: (matcher) => matcher.with(P._, describeEnvIssues),
      defect: () => "defect",
    });

    // THEN the ceiling is the schema's business, not the socket's
    expect(described).toContain("PROBE_PORT: Too big");
  });
});
