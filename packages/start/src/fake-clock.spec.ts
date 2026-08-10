import { describe, expect, it } from "vitest";

import { createFakeClock } from "./fake-clock.js";

describe("createFakeClock", () => {
  it("starts at 0 and only moves when advanced", async () => {
    const clock = createFakeClock();

    expect(clock.now()).toBe(0);
    await clock.advance(1_500);
    expect(clock.now()).toBe(1_500);
  });

  it("starts at the supplied instant", () => {
    expect(createFakeClock(1_000).now()).toBe(1_000);
  });

  it("leaves a sleep pending until its deadline passes", async () => {
    const clock = createFakeClock();
    let woke = false;
    void clock.sleep(5_000).then(() => {
      woke = true;
    });

    await clock.advance(4_999);
    expect(woke).toBe(false);

    await clock.advance(1);
    expect(woke).toBe(true);
  });

  it("resolves a non-positive sleep without waiting", async () => {
    await expect(createFakeClock().sleep(0)).resolves.toBeUndefined();
  });

  it("resolves immediately against an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(createFakeClock().sleep(30_000, controller.signal)).resolves.toBeUndefined();
  });

  it("cuts a pending sleep short when its signal aborts, and forgets it", async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(30_000, controller.signal);

    controller.abort();
    await expect(sleeping).resolves.toBeUndefined();

    // The aborted sleeper is gone rather than merely resolved: advancing past
    // its original deadline must not try to resolve it a second time.
    await clock.advance(60_000);
    expect(clock.now()).toBe(60_000);
  });
});
