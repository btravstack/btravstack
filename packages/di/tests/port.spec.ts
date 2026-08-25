import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { Port } from "../src/index.js";

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
