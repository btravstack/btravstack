import { Ok, OkAsync, type Result } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { systemClock, type Clock } from "./clock.js";
import { drainApp } from "./drain.js";
import type { Serving } from "./runtime.js";
import { createUnitRegistry } from "./units.js";

const servingStub = (): { readonly serving: Serving } => ({
  serving: {
    drain: () => OkAsync(),
    stop: () => OkAsync(),
  },
});

// A clock whose `sleep` never resolves on its own — the test controls each
// call's resolution explicitly by invoking the entry `sleeps` collects, in
// call order. Lets a test park `drainApp` mid-drain and observe/mutate
// registry state before letting it proceed, instead of racing real timers.
const controlledClock = (): { readonly clock: Clock; readonly sleeps: Array<() => void> } => {
  const sleeps: Array<() => void> = [];
  return {
    sleeps,
    clock: {
      now: () => 0,
      sleep: () =>
        new Promise<void>((resolve) => {
          sleeps.push(resolve);
        }),
    },
  };
};

describe("drainApp", () => {
  it("flips readiness false, waits preDrainDelayMs, then tells the runtime to stop accepting — in that order", async () => {
    const order: string[] = [];
    const { serving } = servingStub();

    await drainApp({
      serving: {
        drain: (signal) => {
          order.push("stopAccepting");
          return serving.drain(signal);
        },
        stop: serving.stop,
      },
      registry: createUnitRegistry(),
      clock: {
        now: () => 0,
        sleep: (ms) => {
          order.push(`sleep:${ms}`);
          return Promise.resolve();
        },
      },
      preDrainDelayMs: 5_000,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => order.push("ready:false"),
    });

    // The pre-drain delay's sleep, and the runtime being told to stop
    // accepting, land between readiness flipping and the deadline race — in
    // that order. The fourth entry is the drain-timeout sleep being armed as
    // the other half of that race (see the beat-3 tests below for what
    // actually decides it) — a faithful side effect, not noise.
    expect(order).toEqual(["ready:false", "sleep:5000", "stopAccepting", "sleep:20000"]);
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
      onUnready: () => {},
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
      clock: { now: () => 0, sleep: () => Promise.resolve() },
      preDrainDelayMs: 0,
      drainTimeoutMs: 0,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    expect(report).toBeOkWith({ inFlightAtStart: 1, completed: 0, abandoned: 1 });
    expect(aborted).toBe(true);
  });

  it("counts a unit that settles before the deadline as completed, alongside one left open", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    const { clock, sleeps } = controlledClock();

    let releaseFirst!: (result: Result<string, never>) => void;
    const first = registry.run(
      { kind: "t", id: "1" },
      () =>
        new Promise<Result<string, never>>((resolve) => {
          releaseFirst = resolve;
        }),
    );
    void registry.run({ kind: "t", id: "2" }, async () => {
      await new Promise(() => {});
      return Ok("never");
    });

    const report = drainApp({
      serving,
      registry,
      clock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    // Release the pre-drain delay so `drainApp` reaches beat 3 and arms the
    // deadline race.
    sleeps[0]?.();
    await Promise.resolve();

    // Settle the first unit and wait for its `finally` — the `closed()`
    // increment — to actually run before the deadline fires.
    releaseFirst(Ok("done"));
    await first;

    // The second unit never settles, so only the deadline sleep can end the
    // race.
    sleeps[1]?.();

    expect(await report).toBeOkWith({ inFlightAtStart: 2, completed: 1, abandoned: 1 });
  });

  it("does not let a unit that starts after inFlightAtStart is sampled drive completed negative", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    const { clock, sleeps } = controlledClock();

    const report = drainApp({
      serving,
      registry,
      clock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    // `inFlightAtStart`/`closedAtStart` are sampled synchronously inside this
    // call, before anything below runs — both are 0, since no unit exists
    // yet.
    sleeps[0]?.();
    await Promise.resolve();

    // A unit starts *after* that sample and is still open when the deadline
    // hits. The naive `inFlightAtStart - abandoned` (0 - 1) goes negative;
    // the monotonic `closed() - closedAtStart` (0 - 0) does not — this is
    // the exact shape the reviewer reproduced ({ inFlightAtStart: 0,
    // completed: -1, abandoned: 1 }).
    void registry.run({ kind: "t", id: "late" }, async () => {
      await new Promise(() => {});
      return Ok("never");
    });

    sleeps[1]?.();

    const result = await report;
    expect(result).toBeOkWith({ inFlightAtStart: 0, completed: 0, abandoned: 1 });
    if (result.isOk()) {
      expect(result.value.completed).toBeGreaterThanOrEqual(0);
    }
  });

  it("resolves both sleeps immediately when skip is already aborted", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    const controller = new AbortController();
    controller.abort();

    const startedAt = Date.now();
    const report = await drainApp({
      serving,
      registry,
      clock: systemClock,
      preDrainDelayMs: 30_000,
      drainTimeoutMs: 30_000,
      skip: controller.signal,
      onUnready: () => {},
    });

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(report).toBeOkWith({ inFlightAtStart: 0, completed: 0, abandoned: 0 });
  });

  it("cuts the current wait short when skip is aborted mid-drain", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();
    const controller = new AbortController();

    const startedAt = Date.now();
    const report = drainApp({
      serving,
      registry,
      clock: systemClock,
      preDrainDelayMs: 30_000,
      drainTimeoutMs: 30_000,
      skip: controller.signal,
      onUnready: () => {},
    });

    // Let the real pre-drain-delay timer actually get scheduled before
    // aborting mid-flight, rather than pre-aborting like the test above.
    await new Promise((resolve) => setTimeout(resolve, 10));
    controller.abort();

    expect(await report).toBeOkWith({ inFlightAtStart: 0, completed: 0, abandoned: 0 });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
