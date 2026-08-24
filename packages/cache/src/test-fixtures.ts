import { randomUUID } from "node:crypto";

import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { createFakeClock, type FakeClock } from "@btravstack/testing";
import { OkAsync } from "unthrown";
import { inject, test } from "vitest";

import { CacheBackend, type CacheService } from "./cache.js";
import { memoryCacheBackend } from "./memory.js";
import { redisCache } from "./redis.js";

export type CacheFixtures = {
  /** The clock the memory adapter measures a ttl against, so an expiry needs no real wait. */
  readonly clock: FakeClock;
  /** The in-memory adapter's service, on that clock. */
  readonly backend: CacheService;
  /** This test's own key space on the shared server — a UUID, so nothing collides and nothing needs cleaning up. */
  readonly keyPrefix: string;
  /** The Redis adapter's service, resolved out of a graph and disconnected when the test ends. */
  readonly redis: CacheService;
  /** The same service, after its scope closed — the shape an adapter takes when the server is gone. */
  readonly disconnected: CacheService;
};

export const it = test.extend<CacheFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  clock: async ({}, use) => {
    await use(createFakeClock());
  },
  backend: async ({ clock }, use) => {
    await use(memoryCacheBackend({ clock }));
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  keyPrefix: async ({}, use) => {
    await use(`test:${randomUUID()}:`);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  redis: async ({}, use) => {
    // `Module.scoped` runs the test body inside the scope, so the connection
    // the provider acquired is closed by the scope closing — the same path a
    // real application's drain takes, rather than a teardown of its own.
    const env = { REDIS_URL: inject("__TESTCONTAINERS_REDIS_URL__") };
    const served = await Module.scoped(
      Module("RedisCacheFixture")({
        imports: [redisCache()],
        provides: [Provider(Env)({ value: env })],
        exports: [CacheBackend],
      }),
      async (ctx) => {
        await use(ctx.get(CacheBackend));
        return OkAsync();
      },
    );
    // A fixture that swallowed a failing scope would leave the test green on
    // a connection that never opened.
    served.getOrThrow();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  disconnected: async ({}, use) => {
    // The service outlives its scope on purpose: the scope closing is what
    // closes the connection, so what the test holds afterwards is an adapter
    // whose server is unreachable — which is the state `CacheUnavailable`
    // exists to describe, reached without breaking the shared container.
    const env = { REDIS_URL: inject("__TESTCONTAINERS_REDIS_URL__") };
    const served = await Module.scoped(
      Module("DisconnectedCacheFixture")({
        imports: [redisCache()],
        provides: [Provider(Env)({ value: env })],
        exports: [CacheBackend],
      }),
      (ctx) => OkAsync(ctx.get(CacheBackend)),
    );

    await use(served.getOrThrow());
  },
});
