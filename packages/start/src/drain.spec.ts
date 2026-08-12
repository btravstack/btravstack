import { Ok, OkAsync, fromSafePromise, type AsyncResult, type Result } from "unthrown";
import { describe, expect, it, vi } from "vitest";

import { systemClock, type Clock } from "./clock.js";
import { drainApp } from "./drain.js";
import type { Serving } from "./runtime.js";
import { createUnitRegistry, type UnitRegistry } from "./units.js";

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
// One real macrotask: every microtask already queued — and every microtask
// those queue in turn — has run by the time it resolves. Used to let `drainApp`
// travel from a released sleep to arming the next one; the `fromSafePromise`
// hop each `Clock.sleep` now carries makes counting microtasks by hand
// unreliable.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const controlledClock = (): { readonly clock: Clock; readonly sleeps: Array<() => void> } => {
  const sleeps: Array<() => void> = [];
  return {
    sleeps,
    clock: {
      now: () => 0,
      sleep: () =>
        fromSafePromise(
          new Promise<void>((resolve) => {
            sleeps.push(resolve);
          }),
        ),
    },
  };
};

const boom = new Error("boom");

// A defect-state `AsyncResult`. A `Defect` has no public constructor by design,
// so a throw caught by a combinator's throw-to-defect net is the documented way
// to build one — which is exactly how a third-party runtime's internal throw
// reaches `drainApp` in production.
const defecting = (): AsyncResult<void, never> =>
  OkAsync().map(() => {
    // oxlint-disable-next-line unthrown/no-throw -- see above: the only documented route to a defect-state `Result`
    throw boom;
  });

const pending = (): AsyncResult<void, never> => fromSafePromise(new Promise<void>(() => {}));

const immediate = (): AsyncResult<void, never> => OkAsync();

// `drainApp` sleeps exactly twice — the pre-drain delay, then the drain
// timeout — so scripting the two in order is what lets a test decide which
// single call defects and which half of beat 3's race can settle at all.
const scriptedClock = (
  preDrain: () => AsyncResult<void, never>,
  timeout: () => AsyncResult<void, never>,
): Clock => {
  let armed = 0;
  return {
    now: () => 0,
    sleep: () => {
      armed += 1;
      return armed === 1 ? preDrain() : timeout();
    },
  };
};

const openUnit = (registry: UnitRegistry): void => {
  void registry.run({ kind: "t", id: "open" }, async () => {
    await new Promise(() => {});
    return Ok("never");
  });
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
          return OkAsync();
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
    const sleep = vi.fn(() => OkAsync());
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
      clock: { now: () => 0, sleep: () => OkAsync() },
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
    await settle();

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

    // `inFlightAtStart`/`closedAtStart` are sampled synchronously inside the
    // call above, before anything here runs — both are 0, since no unit exists
    // yet. This one starts *after* that sample and is still open when the
    // deadline hits. The naive `inFlightAtStart - abandoned` (0 - 1) goes
    // negative; the monotonic `closed() - closedAtStart` (0 - 0) does not —
    // this is the exact shape the reviewer reproduced ({ inFlightAtStart: 0,
    // completed: -1, abandoned: 1 }).
    //
    // It is started before the pre-drain delay is released so that it is
    // already open when beat 3 sequences `awaitIdle()` behind the runtime's
    // `drain`. That keeps the idle branch pending, leaving the deadline sleep
    // as the only thing that can end the race — which is what the release
    // below drives. (A unit opening *inside* that window is the neighbouring
    // test, and is now waited for rather than abandoned.)
    void registry.run({ kind: "t", id: "late" }, async () => {
      await new Promise(() => {});
      return Ok("never");
    });

    sleeps[0]?.();
    await settle();
    sleeps[1]?.();

    const result = await report;
    expect(result).toBeOkWith({ inFlightAtStart: 0, completed: 0, abandoned: 1 });
  });

  it("waits for a unit that opens while the runtime is still stopping accepting", async () => {
    // GIVEN an idle registry and a runtime whose `drain` takes time to resolve —
    // an HTTP server waiting out keep-alive connections is the motivating shape.
    const registry = createUnitRegistry();
    const { clock, sleeps } = controlledClock();
    let releaseDrain!: () => void;

    const report = drainApp({
      serving: {
        drain: () =>
          fromSafePromise(
            new Promise<void>((resolve) => {
              releaseDrain = resolve;
            }),
          ),
        stop: () => OkAsync(),
      },
      registry,
      clock,
      preDrainDelayMs: 0,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    // WHEN a unit opens after beat 3 began — the registry was idle when it did,
    // so a one-shot `awaitIdle()` has already resolved — and settles well before
    // the deadline sleep is ever released.
    sleeps[0]?.();
    await settle();

    let releaseUnit!: (result: Result<string, never>) => void;
    const unit = registry.run(
      { kind: "t", id: "late" },
      () =>
        new Promise<Result<string, never>>((resolve) => {
          releaseUnit = resolve;
        }),
    );

    releaseDrain();
    await settle();

    releaseUnit(Ok("done"));
    await unit;

    // THEN the drain waited for it. Abandoning it would report failed work
    // against a deadline that never fired, with the whole budget unspent.
    expect(await report).toBeOkWith({ inFlightAtStart: 0, completed: 1, abandoned: 0 });
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

  // The four below all guard one rule: every `Result` the drain awaits is
  // inspected. `AsyncResult<void, never>` says the *error* channel is empty, not
  // that a `Defect` cannot be there — dropping one would report a clean
  // shutdown that did not happen.
  it("propagates a Defect from the pre-drain sleep, without telling the runtime to stop accepting", async () => {
    const { serving } = servingStub();
    const drain = vi.fn(serving.drain);

    const report = await drainApp({
      serving: { drain, stop: serving.stop },
      registry: createUnitRegistry(),
      // Only the pre-drain sleep defects: the timeout never settles and the
      // registry is idle, so dropping this `Result` leaves an `Ok` report.
      clock: scriptedClock(defecting, pending),
      preDrainDelayMs: 5_000,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    expect(report).toBeDefectWith(boom);
    expect(drain).not.toHaveBeenCalled();
  });

  it("propagates a Defect from the drain-timeout sleep", async () => {
    const registry = createUnitRegistry();
    const { serving } = servingStub();

    // Keeps `awaitIdle` pending, so the timeout sleep is the only branch of the
    // race that can settle it.
    openUnit(registry);

    const report = await drainApp({
      serving,
      registry,
      clock: scriptedClock(immediate, defecting),
      preDrainDelayMs: 0,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    expect(report).toBeDefectWith(boom);
  });

  it("propagates a Defect from the runtime's drain", async () => {
    const { serving } = servingStub();

    const report = await drainApp({
      serving: { drain: defecting, stop: serving.stop },
      registry: createUnitRegistry(),
      clock: scriptedClock(immediate, pending),
      preDrainDelayMs: 0,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    expect(report).toBeDefectWith(boom);
  });

  it("propagates a Defect from the registry going idle", async () => {
    const { serving } = servingStub();

    const report = await drainApp({
      serving,
      registry: { ...createUnitRegistry(), awaitIdle: defecting },
      clock: scriptedClock(immediate, pending),
      preDrainDelayMs: 0,
      drainTimeoutMs: 20_000,
      skip: new AbortController().signal,
      onUnready: () => {},
    });

    expect(report).toBeDefectWith(boom);
  });
});
