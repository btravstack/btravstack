import { setTimeout as delay } from "node:timers/promises";

import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";
import { withLock } from "./lock.js";

describe("withLock", () => {
  it("lets one holder finish before the next begins", async ({ lock }) => {
    // GIVEN two callers of the same lock, each recording when it enters and leaves
    const events: string[] = [];
    const hold = (id: string) =>
      withLock(lock.name, async () => {
        events.push(`enter:${id}`);
        await delay(50);
        events.push(`exit:${id}`);
      });

    // WHEN both run at once
    await Promise.all([hold("a"), hold("b")]);

    // THEN neither entered while the other held it — which of the two won is
    // the operating system's business, so only the shape is asserted
    expect(events.map((event) => event.split(":")[0])).toEqual(["enter", "exit", "enter", "exit"]);
  });

  it("breaks a lock whose owner is no longer running", async ({ lock, deadPid }) => {
    // GIVEN a lock left behind by a process that never reached its release
    lock.plant(deadPid);

    // WHEN another caller asks for it
    // THEN pid liveness broke it, rather than the caller waiting out STALE_MS
    await expect(withLock(lock.name, () => Promise.resolve("taken"))).resolves.toBe("taken");
  });

  it("releases the lock when the work fails", async ({ lock }) => {
    // GIVEN a holder whose work rejected
    await withLock(lock.name, () => Promise.reject(new Error("boom"))).catch(() => undefined);

    // WHEN the next caller asks for the same lock
    // THEN the `finally` had released it
    await expect(withLock(lock.name, () => Promise.resolve("taken"))).resolves.toBe("taken");
  });
});
