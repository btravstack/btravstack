import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Port } from "./index.js";

beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => void vi.restoreAllMocks());

test("a port exposes its id as the runtime key", () => {
  // GIVEN
  class Logger extends Port("Logger")<{ readonly log: () => void }> {}
  // WHEN its id is read
  // THEN
  expect(Logger.portId).toBe("Logger");
});

test("a duplicate id warns exactly once", () => {
  // GIVEN a port declared under an id
  class First extends Port("Duplicated")<{ readonly a: 1 }> {}
  // WHEN a second is declared under the same one
  class Second extends Port("Duplicated")<{ readonly a: 1 }> {}
  void First;
  void Second;
  // THEN
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Duplicated"));
});

// The duplicate-id warning is a development aid, folded out of production
// builds by define-replacement. The early return is what makes that true.
test("says nothing about a duplicate id in production", () => {
  // GIVEN
  const previous = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";

  try {
    // WHEN
    Port("DuplicateInProduction");
    Port("DuplicateInProduction");

    // THEN
    expect(console.warn).not.toHaveBeenCalled();
  } finally {
    process.env["NODE_ENV"] = previous;
  }
});
