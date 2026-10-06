import { describe, expect, it } from "vitest";

import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("reports a moving now", () => {
    // GIVEN the system clock
    // WHEN its now is read
    const before = systemClock.now();
    // THEN
    expect(typeof before).toBe("number");
    expect(before).toBeGreaterThan(0);
  });

  it("sleeps for the requested duration", async () => {
    // GIVEN
    const before = systemClock.now();
    // WHEN
    await systemClock.sleep(20);
    // THEN
    expect(systemClock.now() - before).toBeGreaterThanOrEqual(15);
  });

  it("resolves early when the signal aborts, without rejecting", async () => {
    // GIVEN
    const controller = new AbortController();
    const before = systemClock.now();
    const sleeping = systemClock.sleep(5_000, controller.signal);
    // WHEN
    controller.abort();

    // THEN
    await expect(sleeping).toBeOkWith(undefined);
    expect(systemClock.now() - before).toBeLessThan(1_000);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    // GIVEN an already-aborted signal
    // WHEN the clock sleeps on it
    // THEN
    await expect(systemClock.sleep(5_000, AbortSignal.abort())).toBeOkWith(undefined);
  });
});
