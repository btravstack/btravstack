import { P } from "unthrown";
import { describe, expect, it } from "vitest";

import { describeEnvIssues, readEnv } from "./env.js";

describe("readEnv", () => {
  it("falls back to the documented defaults when nothing is set", () => {
    // GIVEN an environment with neither variable set
    const source = {};

    // WHEN it is validated
    const env = readEnv(source);

    // THEN both carry their defaults, as numbers
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

  it("reports a malformed value rather than consuming nothing at all", () => {
    // GIVEN the values `Number()` would silently turn into `NaN` and `0` — and
    // a concurrency of `0` is a worker that takes no messages
    const source = { PROBE_PORT: "abc", CONCURRENCY: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN neither reaches the runtime: both are issues in the error channel,
    // named and in order, asserted on the `Err` itself rather than behind an
    // `env.isErr() &&` guard that evaluates to `false` when it does not hold
    expect(env).toBeErrWith([
      expect.objectContaining({ path: ["PROBE_PORT"] }),
      expect.objectContaining({ path: ["CONCURRENCY"] }),
    ]);
  });

  it("rejects a concurrency no worker should be asked for", () => {
    // GIVEN a number that parses but that nothing sensible would run
    const source = { CONCURRENCY: "1000" };

    // WHEN its error channel is folded into the message a deployment reads
    const described = readEnv(source).match({
      ok: () => "WRONGLY ACCEPTED",
      // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is one type (the schema's list of issues), not a union of cases to enumerate
      errCases: (matcher) => matcher.with(P._, describeEnvIssues),
      defect: () => "defect",
    });

    // THEN the ceiling is the schema's business, not the scheduler's
    expect(described).toContain("CONCURRENCY: Too big");
  });
});
