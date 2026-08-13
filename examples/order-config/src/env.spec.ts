import { P } from "unthrown";
import { describe, expect } from "vitest";

import { describeEnvIssues } from "./env.js";
import { it } from "./test-fixtures.js";

describe("the shared environment fragments", () => {
  it("falls back to the documented defaults when nothing is set", ({ read }) => {
    // GIVEN an environment with neither variable set
    const source = {};

    // WHEN it is validated
    const env = read(source);

    // THEN both carry their defaults, as numbers
    expect(env).toBeOkWith({ PORT: 3000, CONCURRENCY: 1 });
  });

  it("reads what a deployment actually supplies", ({ read }) => {
    // GIVEN both set, as the strings an environment always holds
    const source = { PORT: "8080", CONCURRENCY: "4" };

    // WHEN it is validated
    const env = read(source);

    // THEN they arrive parsed rather than as strings
    expect(env).toBeOkWith({ PORT: 8080, CONCURRENCY: 4 });
  });

  it("keeps 0 expressible, because an ephemeral bind is legal", ({ read }) => {
    // GIVEN the port a deployment sets when it wants the OS to pick one
    const source = { PORT: "0" };

    // WHEN it is validated
    const env = read(source);

    // THEN it survives — which is exactly why `min(0)` cannot be the guard
    // against a blank value, and why the non-empty string in front of the
    // coercion has to be that guard instead
    expect(env).toBeOkWith({ PORT: 0, CONCURRENCY: 1 });
  });

  it("rejects a variable that is present but empty, rather than defaulting it", ({ read }) => {
    // GIVEN the shape `Number()` reads as `0`
    const source = { PORT: "" };

    // WHEN it is validated
    const env = read(source);

    // THEN it is a configuration error rather than an absent variable: the
    // default is for a variable nobody set, not one set to nothing
    expect(env).toBeErrWith([expect.objectContaining({ path: ["PORT"] })]);
  });

  it("rejects a variable that is present but blank", ({ read }) => {
    // GIVEN whitespace, which trims to the same empty string
    const source = { PORT: "   ", CONCURRENCY: "\t\n" };

    // WHEN it is validated
    const env = read(source);

    // THEN both are issues, named and in order, asserted on the `Err` itself
    // rather than behind a narrowing guard that can quietly not hold
    expect(env).toBeErrWith([
      expect.objectContaining({ path: ["PORT"] }),
      expect.objectContaining({ path: ["CONCURRENCY"] }),
    ]);
  });

  it("reports a malformed value rather than binding NaN", ({ read }) => {
    // GIVEN the value `Number()` would silently turn into `NaN`
    const source = { PORT: "abc" };

    // WHEN it is validated
    const env = read(source);

    // THEN it never reaches a socket
    expect(env).toBeErrWith([expect.objectContaining({ path: ["PORT"] })]);
  });

  it("rejects a number that is not a whole one", ({ read }) => {
    // GIVEN a value `Number()` reads happily and no socket could ever bind
    const source = { PORT: "3.5" };

    // WHEN it is validated
    const env = read(source);

    // THEN it is an issue rather than a silent truncation
    expect(env).toBeErrWith([expect.objectContaining({ path: ["PORT"] })]);
  });

  it("rejects a value outside the range, and says so in the deployment's own words", ({ read }) => {
    // GIVEN a number that parses but cannot be bound
    const source = { PORT: "99999" };

    // WHEN its error channel is folded into the message a deployment prints
    const described = read(source).match({
      ok: () => "WRONGLY ACCEPTED",
      // oxlint-disable-next-line unthrown/no-catch-all-pattern -- `E` is one type (the schema's list of issues), not a union of cases to enumerate
      errCases: (matcher) => matcher.with(P._, describeEnvIssues),
      defect: () => "defect",
    });

    // THEN the range is the schema's business, not the OS's — and the issue
    // arrives named after the variable it is about
    expect(described).toContain("PORT: Too big");
  });
});
