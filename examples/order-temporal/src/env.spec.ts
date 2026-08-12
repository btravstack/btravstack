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
