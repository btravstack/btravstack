import { describe, expect, it, vi } from "vitest";

import { safeSink, stderrSink } from "./events.js";

describe("safeSink", () => {
  it("forwards events to the wrapped sink", () => {
    const calls: unknown[] = [];
    const sink = safeSink((event) => calls.push(event));

    const event = {
      type: "serving",
      runtime: "test",
      info: { port: 3000 },
      probePort: 9000,
    } as const;
    sink(event);

    expect(calls).toEqual([event]);
  });

  it("swallows a throwing sink", () => {
    const sink = safeSink(() => {
      // oxlint-disable-next-line unthrown/no-throw -- the throw IS the subject under test: `safeSink` exists to stop a throwing sink taking the process down mid-shutdown
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

  it("renders an Error cause instead of dropping it to an empty object", () => {
    // GIVEN the two events that exist to carry a cause carry an `Error`, whose
    // `message` and `stack` are both non-enumerable and so invisible to a bare
    // `JSON.stringify`.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // WHEN the crash event is written
    stderrSink({ type: "uncaught", cause: new Error("boom") });

    // THEN the operator can read what died. `{"type":"uncaught","cause":{}}` is
    // the failure this guards: a crash report naming no error.
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining('"cause":{"name":"Error","message":"boom"'),
    );
    write.mockRestore();
  });

  it("still writes the event when the cause is circular", () => {
    // GIVEN a cause `JSON.stringify` refuses outright — a throw here is
    // swallowed by `safeSink`, so the event would be emitted nowhere at all.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const cause: { self?: unknown } = {};
    cause.self = cause;

    // WHEN the event is written
    stderrSink({ type: "uncaught", cause });

    // THEN the type still reaches stderr, rather than the whole event vanishing.
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"type":"uncaught"'));
    write.mockRestore();
  });
});
