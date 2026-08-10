import { Ok } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import type { Clock } from "./clock.js";
import { drainApp } from "./drain.js";
import { createUnitRegistry } from "./units.js";

const immediateClock: Clock = { now: () => 0, sleep: () => Promise.resolve() };

const servingStub = () => {
  const calls: string[] = [];
  return {
    calls,
    serving: {
      drain: () => {
        calls.push("drain");
        return Ok({ inFlightAtStart: 0, completed: 0, abandoned: 0 }).toAsync();
      },
      stop: () => {
        calls.push("stop");
        return Ok(undefined).toAsync();
      },
    },
  };
};

describe("drainApp", () => {
  it("flips readiness false before telling the runtime to stop accepting", async () => {
    const order: string[] = [];
    const { serving } = servingStub();

    await drainApp({
      serving: {
        drain: () => {
          order.push("stopAccepting");
          return Ok({ inFlightAtStart: 0, completed: 0, abandoned: 0 }).toAsync();
        },
        stop: serving.stop,
      },
      registry: createUnitRegistry(),
      clock: immediateClock,
      preDrainDelayMs: 5_000,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onReadyChange: (ready) => order.push(`ready:${ready}`),
    });

    expect(order).toEqual(["ready:false", "stopAccepting"]);
  });

  it("waits preDrainDelayMs before stopping acceptance", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { serving } = servingStub();

    await drainApp({
      serving,
      registry: createUnitRegistry(),
      clock: { now: () => 0, sleep },
      preDrainDelayMs: 5_000,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onReadyChange: () => {},
    });

    expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal));
  });

  it("counts a unit still open at the deadline as abandoned", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    let aborted = false;

    void registry.run({ kind: "t", id: "1" }, async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise(() => {});
      return Ok("never");
    });

    const report = await drainApp({
      serving,
      registry,
      clock: immediateClock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      skip: new AbortController().signal,
      onReadyChange: () => {},
    });

    expect(report).toBeOkWith({ inFlightAtStart: 1, completed: 0, abandoned: 1 });
    expect(aborted).toBe(true);
  });

  it("reports every unit completed when they settle before the deadline", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    const running = registry.run({ kind: "t", id: "1" }, () => Ok("done").toAsync());
    await running;

    const report = await drainApp({
      serving,
      registry,
      clock: immediateClock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      skip: new AbortController().signal,
      onReadyChange: () => {},
    });

    expect(report).toBeOkWith({ inFlightAtStart: 0, completed: 0, abandoned: 0 });
  });
});
