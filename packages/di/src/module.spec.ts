import { describe, expect, test } from "vitest";

import { Module, Port, Provider } from "./index.js";

describe("Module exports", () => {
  test("a provider export is normalised to its port class", () => {
    // GIVEN
    class Logger extends Port("SLogger")<{ readonly log: () => void }> {}
    const logger = Provider(Logger)({ value: { log: () => {} } });

    // WHEN
    const mod = Module("Logging")({ provides: [logger], exports: [logger] });

    // THEN
    expect(mod.exports).toEqual([Logger]);
  });

  test("a port class export is carried through beside a provider export", () => {
    // GIVEN
    class Clock extends Port("SClock")<{ readonly now: () => number }> {}
    class Tracer extends Port("STracer")<{ readonly span: () => void }> {}
    const clock = Provider(Clock)({ value: { now: () => 0 } });
    const tracer = Provider(Tracer)({ value: { span: () => {} } });

    // WHEN
    const mod = Module("Mixed")({ provides: [clock, tracer], exports: [Clock, tracer] });

    // THEN
    expect(mod.exports).toEqual([Clock, Tracer]);
  });
});
