import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { brokerLog } from "./broker-log.js";

describe("brokerLog", () => {
  it("reports warnings and errors and drops debug and info", ({ recorder, observations }) => {
    // GIVEN the library's logger over an observer
    const log = brokerLog([recorder]);

    // WHEN the library writes at every level
    log.debug("debug line");
    log.info("info line");
    log.warn("warn line", { error: "refused" });
    log.error("error line");

    // THEN only the warning and the error reached the observer, each an error outcome
    expect(observations).toEqual([
      {
        operation: expect.objectContaining({
          attributes: { level: "warn" },
          details: { message: "warn line" },
        }),
        settled: { outcome: "error", attributes: {}, cause: "refused" },
      },
      {
        operation: expect.objectContaining({
          attributes: { level: "error" },
          details: { message: "error line" },
        }),
        settled: { outcome: "error", attributes: {} },
      },
    ]);
  });
});
