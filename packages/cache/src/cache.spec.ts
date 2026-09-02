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
