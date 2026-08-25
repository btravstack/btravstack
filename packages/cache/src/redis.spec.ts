import { setTimeout as delay } from "node:timers/promises";

import { fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { it } from "./__tests__/test-fixtures.js";

describe("redisCache", () => {
  it("answers a stored value", async ({ redis, keyPrefix }) => {
    // GIVEN a key that was set
    // WHEN it is read back
    const read = redis.set(`${keyPrefix}k`, { n: 1 }).flatMap(() => redis.get(`${keyPrefix}k`));

    // THEN the hit carries the value, JSON round-tripped
    await expect(read).toBeOkWith({ value: { n: 1 } });
  });

  it("answers undefined for a key nobody set", async ({ redis, keyPrefix }) => {
    // GIVEN nothing stored under this test's prefix
    // WHEN an absent key is read
    const read = redis.get(`${keyPrefix}absent`);

    // THEN a miss is Ok, not an error
    await expect(read).toBeOkWith(undefined);
  });

  it("stops answering once the ttl has passed", async ({ redis, keyPrefix }) => {
    // GIVEN a value stored with a 50ms ttl
    // WHEN the server's own clock passes it — the one wait a fake clock
    // cannot stand in for, because the expiry is Redis's and not this
    // process's
    const read = redis
      .set(`${keyPrefix}k`, "v", { ttlMs: 50 })
      .flatTap(() => fromSafePromise(delay(80)))
      .flatMap(() => redis.get(`${keyPrefix}k`));

    // THEN the read is a miss
    await expect(read).toBeOkWith(undefined);
  });

  it("forgets a deleted key", async ({ redis, keyPrefix }) => {
    // GIVEN a stored key
    // WHEN it is deleted and read back
    const read = redis
      .set(`${keyPrefix}k`, "v")
      .flatTap(() => redis.delete(`${keyPrefix}k`))
      .flatMap(() => redis.get(`${keyPrefix}k`));

    // THEN the read is a miss
    await expect(read).toBeOkWith(undefined);
  });
});

describe("redisCache, once its connection is gone", () => {
  it("answers CacheUnavailable on a read", async ({ disconnected, keyPrefix }) => {
    // GIVEN an adapter whose scope has closed
    // WHEN a key is read
    const read = disconnected.get(`${keyPrefix}k`);

    // THEN the failure is modeled, naming the operation and the key
    await expect(read).toBeErrWith(
      expect.objectContaining({ operation: "get", key: `${keyPrefix}k` }),
    );
  });

  it("answers CacheUnavailable on a write", async ({ disconnected, keyPrefix }) => {
    // GIVEN an adapter whose scope has closed
    // WHEN a key is written
    const written = disconnected.set(`${keyPrefix}k`, "v");

    // THEN the failure is modeled, naming the operation and the key
    await expect(written).toBeErrWith(
      expect.objectContaining({ operation: "set", key: `${keyPrefix}k` }),
    );
  });

  it("answers CacheUnavailable on a delete", async ({ disconnected, keyPrefix }) => {
    // GIVEN an adapter whose scope has closed
    // WHEN a key is deleted
    const removed = disconnected.delete(`${keyPrefix}k`);

    // THEN the failure is modeled, naming the operation and the key
    await expect(removed).toBeErrWith(
      expect.objectContaining({ operation: "delete", key: `${keyPrefix}k` }),
    );
  });
});
