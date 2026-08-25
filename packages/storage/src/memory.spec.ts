import { describe, expect } from "vitest";

import { aDocument, it } from "./test-fixtures.js";

describe("memoryStorageBackend", () => {
  it("answers a stored object with its bytes and its type", async ({ memory }) => {
    // GIVEN a document put under a key
    const document = aDocument();

    // WHEN it is read back
    const read = memory
      .put("a/b.json", document.bytes, { contentType: document.contentType })
      .flatMap(() => memory.get("a/b.json"));

    // THEN both halves came back — the bytes and what they are
    await expect(read).toBeOkWith({
      bytes: document.bytes,
      contentType: "application/json",
    });
  });

  it("answers ObjectNotFound for a key nobody stored", async ({ memory }) => {
    // GIVEN nothing stored
    // WHEN an absent key is read
    const read = memory.get("absent");

    // THEN the failure names the key — unlike a cache, absence here IS an error
    await expect(read).toBeErrWith(expect.objectContaining({ key: "absent" }));
  });

  it("forgets a deleted object", async ({ memory }) => {
    // GIVEN a stored object
    const document = aDocument();

    // WHEN it is deleted and read back
    const read = memory
      .put("a/b.json", document.bytes, { contentType: document.contentType })
      .flatTap(() => memory.delete("a/b.json"))
      .flatMap(() => memory.get("a/b.json"));

    // THEN it is gone
    await expect(read).toBeErrWith(expect.objectContaining({ key: "a/b.json" }));
  });

  it("takes a delete of a key nobody stored", async ({ memory }) => {
    // GIVEN nothing stored
    // WHEN an absent key is deleted
    const removed = memory.delete("absent");

    // THEN delete is idempotent, which is the real store's own behaviour
    await expect(removed).toBeOk();
  });

  it("refuses to presign rather than minting a fiction", async ({ memory }) => {
    // GIVEN a stored object
    const document = aDocument();

    // WHEN a time-limited URL is asked for
    const url = memory
      .put("a/b.json", document.bytes, { contentType: document.contentType })
      .flatMap(() => memory.presignedUrl("a/b.json", { ttlMs: 60_000 }));

    // THEN the adapter says it cannot — a `file://` URL would be a double
    // that passes here and fails in the deployment for a reason no test
    // could have shown
    await expect(url).toBeErrWith(expect.objectContaining({ key: "a/b.json" }));
  });
});
