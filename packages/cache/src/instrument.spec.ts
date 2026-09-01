import { describe, expect } from "vitest";

import { defectiveCache, failingCache, it } from "./__tests__/test-fixtures.js";
import { memoryCache } from "./memory.js";

describe("cache, observed", () => {
  it("opens a span per call, named for the operation and carrying the key", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented cache over the memory adapter
    // WHEN a key is read
    await instrumented.run(memoryCache(), (service) => service.get("k"));

    // THEN one span names the operation and carries the key, and nothing else
    expect(
      instrumented
        .spans()
        .map((span) => ({ name: span.name, key: span.attributes["btravstack.cache.key"] })),
    ).toEqual([{ name: "cache.get", key: "k" }]);
  });

  it("counts a read of an absent key as a miss", async ({ instrumented }) => {
    // GIVEN an instrumented cache with nothing in it
    // WHEN an absent key is read
    await instrumented.run(memoryCache(), (service) => service.get("absent"));

    // THEN the one counted point is a miss on a get. `outcome` is the shared
    // ok-or-error every observed component reports; `result` is the cache's own
    // word for what happened, which is what keeps one dashboard query working
    // across components without losing the detail
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([{ operation: "get", result: "miss", outcome: "ok", value: 1 }]);
  });

  it("counts a read of a stored key as a hit", async ({ instrumented }) => {
    // GIVEN an instrumented cache holding a key
    // WHEN that key is read back
    await instrumented.run(memoryCache(), (service) =>
      service.set("k", "v").flatMap(() => service.get("k")),
    );

    // THEN the set is counted ok and the read is counted a hit
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([
      { operation: "set", result: "ok", outcome: "ok", value: 1 },
      { operation: "get", result: "hit", outcome: "ok", value: 1 },
    ]);
  });

  it("counts a delete as an ordinary ok", async ({ instrumented }) => {
    // GIVEN an instrumented cache holding a key
    // WHEN that key is deleted
    await instrumented.run(memoryCache(), (service) =>
      service.set("k", "v").flatMap(() => service.delete("k")),
    );

    // THEN both writes are counted ok — a delete has no hit-or-miss to tell
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([
      { operation: "set", result: "ok", outcome: "ok", value: 1 },
      { operation: "delete", result: "ok", outcome: "ok", value: 1 },
    ]);
  });

  it("counts and logs a backend that cannot answer", async ({ instrumented }) => {
    // GIVEN an instrumented cache whose adapter is down
    // WHEN a key is read
    await instrumented.run(failingCache(), (service) => service.get("k"));

    // THEN the failure is one error line naming the operation and the key. The
    // line is `@btravstack/observability`'s now rather than this package's — a
    // starter says WHAT happened and the observers say how to record it
    expect(instrumented.lines()).toEqual([
      expect.objectContaining({
        level: "error",
        message: "cache.get failed",
        attributes: expect.objectContaining({
          operation: "get",
          "btravstack.cache.key": "k",
        }),
      }),
    ]);
  });

  it("counts a failed call as an error", async ({ instrumented }) => {
    // GIVEN an instrumented cache whose adapter is down
    // WHEN a key is written
    await instrumented.run(failingCache(), (service) => service.set("k", "v"));

    // THEN the one counted point is an error on a set
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([{ operation: "set", outcome: "error", value: 1 }]);
  });

  it("hands the caller's own Result straight back", async ({ instrumented }) => {
    // GIVEN an instrumented cache whose adapter is down
    // WHEN a key is deleted
    const removed = await instrumented.run(failingCache(), (service) => service.delete("k"));

    // THEN the wrapper is transparent: the backend's error is what arrives
    expect(removed).toBeErrWith(expect.objectContaining({ operation: "delete", key: "k" }));
  });
});

describe("cache, observed, when the backend defects", () => {
  it("still ends the span and counts the call as an error", async ({ instrumented }) => {
    // GIVEN an instrumented cache over an adapter that defects — the shape a
    // value JSON cannot encode produces, which the port does not model
    // WHEN a key is read
    await instrumented.run(defectiveCache(), (service) => service.get("k"));

    // THEN the call is counted an error, and the span it opened was ended
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      spans: instrumented.spans().map((span) => span.name),
    }).toEqual({
      points: [{ operation: "get", outcome: "error", value: 1 }],
      spans: ["cache.get"],
    });
  });
});
