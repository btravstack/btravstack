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

  it("reports a value another writer left under the key, rather than defecting", async ({
    redis,
    otherWriter,
    keyPrefix,
  }) => {
    // GIVEN a key holding bytes this adapter did not encode — a second process
    // sharing the database, which `REDIS_URL` makes easy to arrange by accident
    await otherWriter.set(`${keyPrefix}foreign`, "not json at all");

    // WHEN it is read through the adapter
    const read = redis.get(`${keyPrefix}foreign`);

    // THEN the operation failed, on the channel every caller already degrades
    // to a miss. As a defect — which is what `JSON.parse` inside `.map` used to
    // produce — `readThrough` recovered nothing, so one foreign key made every
    // `getOrSet` on it defect until the key expired.
    await expect(read).toBeErrWith(
      expect.objectContaining({ operation: "get", key: `${keyPrefix}foreign` }),
    );
  });

  it("answers a defect for a value it cannot encode, without throwing at the call", async ({
    redis,
    keyPrefix,
  }) => {
    // GIVEN a value `JSON.stringify` refuses — a `BigInt`, the one this package
    // says is a bug in the caller rather than an outage
    // WHEN it is written
    // THEN the throw is on the returned channel rather than escaping a method
    // typed `AsyncResult`: eagerly evaluated as an argument, it used to come
    // out of `set(...)` as a synchronous exception no caller could catch with a
    // `Result` in hand.
    await expect(redis.set(`${keyPrefix}big`, 1n)).toBeDefectWith(
      expect.objectContaining({ constructor: TypeError }),
    );
  });

  it("answers a defect for a value that serialises to nothing at all", async ({
    redis,
    keyPrefix,
  }) => {
    // GIVEN the OTHER half of what `JSON.stringify` refuses, and the quiet
    // half: a function returns `undefined` rather than throwing, as a
    // top-level `undefined` and a symbol also do
    // WHEN it is written
    // THEN it is a defect like the `BigInt`. Unchecked, that `undefined`
    // reached `client.set`, which refuses it — so a caller's serialisation bug
    // arrived as `CacheUnavailable`, the outage class this package reserves
    // for a server that could not answer.
    await expect(redis.set(`${keyPrefix}fn`, () => 1)).toBeDefectWith(
      expect.objectContaining({ constructor: TypeError }),
    );
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

describe("redisCache, when it cannot connect at all", () => {
  it("answers CacheConnectionFailed rather than defecting the whole boot", async ({
    connectingTo,
  }) => {
    // GIVEN a `REDIS_URL` nothing is listening on — the ordinary shape of a
    // wrong value in a manifest
    // WHEN the graph is built
    const built = connectingTo("redis://127.0.0.1:1");

    // THEN it is a modeled startup failure, which `runMain` exits `1` for.
    // node-redis retries the first connect forever, so this used to HANG the
    // build — a pod answering `/livez`, never `/readyz`, with no report and no
    // exit code for a typo in a manifest. The `'error'` the client emits on
    // each attempt is absorbed by the adapter's listener; unhandled, the first
    // one would be an `EventEmitter` throw that never reached this channel.
    await expect(built).toBeErrTagged(
      "CacheConnectionFailed",
      expect.objectContaining({ reason: expect.any(String) }),
    );
  });

  it("answers CacheConnectionFailed for a URL the client cannot even parse", async ({
    connectingTo,
  }) => {
    // GIVEN a `REDIS_URL` that is not one. `Config.string` only asks that it is
    // present, so the value reaches `createClient` — which parses it
    // SYNCHRONOUSLY and throws `TypeError: Invalid protocol` here
    // WHEN the graph is built
    const built = connectingTo("http://localhost:6379");

    // THEN it is the same modeled startup failure a dead server gives, rather
    // than a defect and exit `70`: the throw happens before `connect()` is ever
    // reached, so the `fromPromise` guarding that call could not see it.
    await expect(built).toBeErrTagged(
      "CacheConnectionFailed",
      expect.objectContaining({ reason: expect.stringContaining("Invalid protocol") }),
    );
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
