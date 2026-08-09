import { describe, expect, it, vi } from "vitest";

import { safeSink, stderrSink } from "./events.js";

describe("safeSink", () => {
  it("forwards events to the wrapped sink", () => {
    const calls: unknown[] = [];
    const sink = safeSink((event) => calls.push(event));

    sink({ type: "serving", runtime: "test" });

    expect(calls).toEqual([{ type: "serving", runtime: "test" }]);
  });

  it("swallows a throwing sink", () => {
    const sink = safeSink(() => {
      throw new Error("broken reporter");
    });

    expect(() => sink({ type: "building" })).not.toThrow();
  });
});

describe("stderrSink", () => {
  it("writes one JSON line per event", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    stderrSink({ type: "draining", inFlight: 2 });

    expect(write).toHaveBeenCalledWith('{"type":"draining","inFlight":2}\n');
    write.mockRestore();
  });
});
