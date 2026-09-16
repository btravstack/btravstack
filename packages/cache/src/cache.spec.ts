import { ErrAsync, OkAsync } from "unthrown";
import { describe, expect } from "vitest";

import { failingBackend, it } from "./__tests__/test-fixtures.js";
import { CacheUnavailable, readThrough } from "./cache.js";

describe("readThrough", () => {
  it("stores what the loader produced, under the ttl it was given", async ({ backend, clock }) => {
    // GIVEN a read-through over the in-memory adapter, on a clock a test drives
    const cache = readThrough(backend);

    // WHEN a miss runs the loader, and the clock passes the ttl afterwards
    const read = await cache
      .getOrSet("k", () => OkAsync("v"), { ttlMs: 1_000 })
      .flatMap(() => backend.get("k"))
      .flatMap((stored) =>
        clock
          .advance(1_000)
          .flatMap(() => backend.get("k").map((expired) => ({ stored, expired }))),
      );

    // THEN the loader's value was stored, and it expired on the ttl rather than outliving it
    expect(read).toBeOkWith({ stored: { value: "v" }, expired: undefined });
  });

  // One key per case, so a failure names the shape that regressed rather than a
  // projection of four. A loop rather than `it.each`, because the extended `it`
  // hands a test its fixtures through the FIRST parameter and `each` has
  // already taken it. Every case is a `ttlMs` a caller computed: a deadline
  // already passed, a sub-millisecond remainder, arithmetic that went `NaN`,
  // and a value past the safe-integer range — finite, so it would reach Redis
  // as a `PX` the server answers an argument error for.
  for (const { shape, ttlMs } of [
    { shape: "zero", ttlMs: 0 },
    { shape: "negative", ttlMs: -1 },
    { shape: "sub-millisecond", ttlMs: 0.4 },
    { shape: "NaN", ttlMs: Number.NaN },
    { shape: "beyond the safe-integer range", ttlMs: 1e100 },
  ]) {
    it(`does not store a value whose ttl is ${shape}`, async ({ backend }) => {
      // GIVEN a read-through over the in-memory adapter
      const cache = readThrough(backend);

      // WHEN a value is written under that ttl and read back
      const read = await cache.set(shape, "v", { ttlMs }).flatMap(() => backend.get(shape));

      // THEN it is not in the cache, and the write did not fail. Storing
      // without expiry would turn an arithmetic slip into a leak, and the
      // Redis adapter used to report `PX 0` as `CacheUnavailable` — an outage
      // class, for a caller's own bug.
      expect(read).toBeOkWith(undefined);
    });
  }

  it("rounds a ttl the adapter could not have taken whole", async ({ backend, clock }) => {
    // GIVEN a ttl with a fraction big enough to round up — a value this rounds
    // rather than refuses, because `1500.5` is an ordinary computed number and
    // dropping it would surprise the caller who wrote the arithmetic
    const cache = readThrough(backend);

    // WHEN it is stored and the clock stops one millisecond short of the round
    const read = await cache
      .set("k", "v", { ttlMs: 1_000.6 })
      .flatMap(() => clock.advance(1_000))
      .flatMap(() => backend.get("k"));

    // THEN the value is still there: it was stored under `1001`, not dropped
    expect(read).toBeOkWith({ value: "v" });
  });

  it("answers a hit without running the loader", async ({ backend }) => {
    // GIVEN a key the cache already holds
    const cache = readThrough(backend);
    let loaded = 0;

    // WHEN it is read through a loader that counts its own calls
    const read = await cache
      .set("k", "cached")
      .flatMap(() =>
        cache.getOrSet("k", () => {
          loaded += 1;
          return OkAsync("loaded");
        }),
      )
      .map((value) => ({ value, loaded }));

    // THEN the stored value came back and the loader never ran
    expect(read).toBeOkWith({ value: "cached", loaded: 0 });
  });

  it("degrades to the loader when the cache cannot answer", async () => {
    // GIVEN an adapter that is down
    const cache = readThrough(failingBackend);

    // WHEN a value is read through it
    const read = await cache.getOrSet("k", () => OkAsync("v"));

    // THEN the caller gets the loader's answer, not the cache's failure
    expect(read).toBeOkWith("v");
  });

  it("does not fail the caller when the write fails", async () => {
    // GIVEN an adapter that reads a miss and refuses every write
    const cache = readThrough({
      get: () => OkAsync(undefined),
      set: (key) => ErrAsync(new CacheUnavailable({ operation: "set", key })),
      delete: (key) => ErrAsync(new CacheUnavailable({ operation: "delete", key })),
    });

    // WHEN a value is read through it
    const read = await cache.getOrSet("k", () => OkAsync("v"));

    // THEN the best-effort write is nobody's error but the cache's
    expect(read).toBeOkWith("v");
  });

  it("passes the loader's own failure through", async ({ backend }) => {
    // GIVEN a loader that fails
    const cache = readThrough(backend);

    // WHEN a miss runs it
    const read = await cache.getOrSet("k", () =>
      ErrAsync(new CacheUnavailable({ operation: "get", key: "upstream" })),
    );

    // THEN what the caller sees is the loader's error, unwrapped
    expect(read).toBeErrTagged("CacheUnavailable", { operation: "get", key: "upstream" });
  });
});
