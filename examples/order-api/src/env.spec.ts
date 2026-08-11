import { describe, expect, it } from "vitest";

import { describeEnvIssues, readEnv } from "./env.js";

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

  it("reports a malformed port as a value rather than binding NaN", () => {
    // GIVEN the values `Number()` would silently turn into `NaN` and `0`
    const source = { PORT: "abc", PROBE_PORT: "" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN neither reaches a socket: both are issues in the error channel
    expect(env).toBeErr();
    expect(env.isErr() && env.error.map((issue) => issue.path?.[0])).toEqual([
      "PORT",
      "PROBE_PORT",
    ]);
  });

  it("rejects a port outside the range a socket can take", () => {
    // GIVEN a number that parses but cannot be bound
    const source = { PORT: "99999" };

    // WHEN it is validated
    const env = readEnv(source);

    // THEN the range is the schema's business, not the OS's
    expect(env).toBeErr();
    expect(env.isErr() && describeEnvIssues(env.error)).toContain("PORT: Too big");
  });
});
