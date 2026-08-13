import { describe, expect, it } from "vitest";

import { systemClock } from "./clock.js";

describe("systemClock", () => {
  it("reports a moving now", () => {
    const before = systemClock.now();
    expect(typeof before).toBe("number");
    expect(before).toBeGreaterThan(0);
  });

  it("sleeps for the requested duration", async () => {
    const before = systemClock.now();
    await systemClock.sleep(20);
    expect(systemClock.now() - before).toBeGreaterThanOrEqual(15);
  });

  it("resolves early when the signal aborts, without rejecting", async () => {
    const controller = new AbortController();
    const before = systemClock.now();
    const sleeping = systemClock.sleep(5_000, controller.signal);
    controller.abort();

    await expect(sleeping).toBeOkWith(undefined);
    expect(systemClock.now() - before).toBeLessThan(1_000);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    await expect(systemClock.sleep(5_000, AbortSignal.abort())).toBeOkWith(undefined);
  });
});
