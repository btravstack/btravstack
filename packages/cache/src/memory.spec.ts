import { describe, expect } from "vitest";

import { it } from "./test-fixtures.js";

describe("memoryCacheBackend", () => {
  it("answers a stored value", async ({ backend }) => {
    // GIVEN a key that was set
    // WHEN it is read back
    const read = backend.set("k", { n: 1 }).flatMap(() => backend.get("k"));

    // THEN the hit carries the value
    await expect(read).toBeOkWith({ value: { n: 1 } });
  });

  it("answers undefined for a key nobody set", async ({ backend }) => {
    // GIVEN nothing stored
    // WHEN an absent key is read
    const read = backend.get("absent");

    // THEN a miss is Ok, not an error
    await expect(read).toBeOkWith(undefined);
  });

  it("tells a cached null from a miss", async ({ backend }) => {
    // GIVEN null stored under a key
    // WHEN it is read back
    const read = backend.set("k", null).flatMap(() => backend.get("k"));

    // THEN the hit is a hit, carrying null — which is why a hit is a record
    await expect(read).toBeOkWith({ value: null });
  });

  it("stops answering once the ttl has passed", async ({ backend, clock }) => {
    // GIVEN a value stored with a one-second ttl
    // WHEN the clock passes it
    const read = backend
      .set("k", "v", { ttlMs: 1_000 })
      .flatTap(() => clock.advance(1_001))
      .flatMap(() => backend.get("k"));

    // THEN the read is a miss
    await expect(read).toBeOkWith(undefined);
  });

  it("still answers just before the ttl", async ({ backend, clock }) => {
    // GIVEN a value stored with a one-second ttl
    // WHEN the clock stops one millisecond short
    const read = backend
      .set("k", "v", { ttlMs: 1_000 })
      .flatTap(() => clock.advance(999))
      .flatMap(() => backend.get("k"));

    // THEN the value is still there
    await expect(read).toBeOkWith({ value: "v" });
  });

  it("forgets a deleted key", async ({ backend }) => {
    // GIVEN a stored key
    // WHEN it is deleted and read back
    const read = backend
      .set("k", "v")
      .flatTap(() => backend.delete("k"))
      .flatMap(() => backend.get("k"));

    // THEN the read is a miss
    await expect(read).toBeOkWith(undefined);
  });

  it("takes a delete of a key nobody set", async ({ backend }) => {
    // GIVEN nothing stored
    // WHEN an absent key is deleted
    const removed = backend.delete("absent");

    // THEN delete is idempotent
    await expect(removed).toBeOk();
  });
});
