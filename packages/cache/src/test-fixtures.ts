import { createFakeClock, type FakeClock } from "@btravstack/testing";
import { test } from "vitest";

import type { CacheService } from "./cache.js";
import { memoryCacheBackend } from "./memory.js";

export type CacheFixtures = {
  /** The clock the memory adapter measures a ttl against, so an expiry needs no real wait. */
  readonly clock: FakeClock;
  /** The in-memory adapter's service, on that clock. */
  readonly backend: CacheService;
};

export const it = test.extend<CacheFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: a fixture that names no other fixture still takes the destructured first parameter
  clock: async ({}, use) => {
    await use(createFakeClock());
  },
  backend: async ({ clock }, use) => {
    await use(memoryCacheBackend({ clock }));
  },
});
