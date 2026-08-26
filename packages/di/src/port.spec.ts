import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Port } from "./index.js";

beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => {}));
afterEach(() => void vi.restoreAllMocks());

test("a port exposes its id as the runtime key", () => {
  class Logger extends Port("Logger")<{ readonly log: () => void }> {}
  expect(Logger.portId).toBe("Logger");
});

test("a duplicate id warns exactly once", () => {
  class First extends Port("Duplicated")<{ readonly a: 1 }> {}
  class Second extends Port("Duplicated")<{ readonly a: 1 }> {}
  void First;
  void Second;
  expect(console.warn).toHaveBeenCalledTimes(1);
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("Duplicated"));
});

// The duplicate-id warning is a development aid, folded out of production
// builds by define-replacement. The early return is what makes that true.
test("says nothing about a duplicate id in production", () => {
  const previous = process.env["NODE_ENV"];
  process.env["NODE_ENV"] = "production";

  try {
    Port("DuplicateInProduction");
    Port("DuplicateInProduction");

    expect(console.warn).not.toHaveBeenCalled();
  } finally {
    process.env["NODE_ENV"] = previous;
  }
});
