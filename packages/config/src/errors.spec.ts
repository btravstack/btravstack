import { describe, expect, it } from "vitest";

import { describeIssues } from "./errors.js";

describe("describeIssues", () => {
  it("writes one indented line per issue, naming the variable", () => {
    // GIVEN two wrong variables, as an operator's environment produced them
    const issues = [
      { variable: "AMQP_URL", message: "must be a non-empty string" },
      { variable: "HTTP_PORT", message: "expected a whole number" },
    ];

    // WHEN they are described
    // THEN each line names the variable to fix — this is what an operator
    // reads on a failed boot, so the variable comes first and the lines are
    // indented under whatever headline the reporter prints
    expect(describeIssues(issues)).toBe(
      "  AMQP_URL: must be a non-empty string\n  HTTP_PORT: expected a whole number",
    );
  });

  it("describes an empty list as nothing at all", () => {
    // GIVEN no issues — the shape a caller gets when it describes before
    // checking whether there was anything to describe
    // WHEN they are described
    // THEN the result is empty rather than a stray blank line
    expect(describeIssues([])).toBe("");
  });
});
