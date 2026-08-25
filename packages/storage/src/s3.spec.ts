import { describe, expect } from "vitest";

import { aDocument, it } from "./__tests__/test-fixtures.js";

describe("s3Storage", () => {
  it("answers a stored object with its bytes and its type", async ({ s3, keyPrefix }) => {
    // GIVEN a document put under this test's own prefix
    const document = aDocument();

    // WHEN it is read back off the real store
    const read = s3
      .put(`${keyPrefix}b.json`, document.bytes, { contentType: document.contentType })
      .flatMap(() => s3.get(`${keyPrefix}b.json`));

    // THEN both halves survived the round trip
    await expect(read).toBeOkWith({
      bytes: document.bytes,
      contentType: "application/json",
    });
  });

  it("answers ObjectNotFound for a key nobody stored", async ({ s3, keyPrefix }) => {
    // GIVEN nothing under this prefix
    // WHEN an absent key is read
    const read = s3.get(`${keyPrefix}absent.json`);

    // THEN the store's own NoSuchKey became the port's modeled absence,
    // which is a different fact from the store being unreachable
    await expect(read).toBeErrWith(expect.objectContaining({ key: `${keyPrefix}absent.json` }));
  });

  it("takes a delete of a key nobody stored", async ({ s3, keyPrefix }) => {
    // GIVEN nothing under this prefix
    // WHEN an absent key is deleted
    const removed = s3.delete(`${keyPrefix}absent.json`);

    // THEN delete is idempotent — S3's own behaviour, not a fiction over it
    await expect(removed).toBeOk();
  });

  it("mints a url that reads the object without credentials", async ({ s3, keyPrefix }) => {
    // GIVEN a stored document
    const document = aDocument();
    const url = await s3
      .put(`${keyPrefix}b.json`, document.bytes, { contentType: document.contentType })
      .flatMap(() => s3.presignedUrl(`${keyPrefix}b.json`, { ttlMs: 60_000 }));

    // WHEN the url is followed by a plain fetch, carrying no credentials
    const response = await fetch(url.getOrThrow());

    // THEN it served the bytes — which is the whole point of the arm, and
    // what no in-memory adapter could have proved
    expect({ status: response.status, bytes: (await response.arrayBuffer()).byteLength }).toEqual({
      status: 200,
      bytes: document.bytes.byteLength,
    });
  });

  it("mints a url for a key nobody stored, because presigning asks the store nothing", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN nothing under this prefix
    // WHEN a url is asked for anyway
    const url = await s3.presignedUrl(`${keyPrefix}absent.json`, { ttlMs: 60_000 });

    // THEN one is minted, and it 404s when followed — the reason the arm has
    // no ObjectNotFound: a check would cost a round trip per call
    const response = await fetch(url.getOrThrow());
    expect(response.status).toBe(404);
  });
});

describe("s3Storage, when the store cannot be reached", () => {
  it("answers StorageUnavailable on a write", async ({ unreachable }) => {
    // GIVEN an adapter pointed at an endpoint that is not listening
    // WHEN an object is written
    const written = unreachable.put("a/b.json", new Uint8Array([1]), {
      contentType: "application/json",
    });

    // THEN the failure is modeled, naming the operation and the key — and it
    // is NOT ObjectNotFound, which is the distinction the arm exists for
    await expect(written).toBeErrWith(
      expect.objectContaining({ operation: "put", key: "a/b.json", reason: expect.any(String) }),
    );
  });

  it("answers StorageUnavailable on a read, rather than calling it missing", async ({
    unreachable,
  }) => {
    // GIVEN an adapter pointed at an endpoint that is not listening
    // WHEN an object is read
    const read = unreachable.get("a/b.json");

    // THEN a store that is down is told apart from a key that is absent: a
    // caller retries one and gives up on the other
    await expect(read).toBeErrWith(expect.objectContaining({ operation: "get", key: "a/b.json" }));
  });

  it("answers StorageUnavailable on a delete", async ({ unreachable }) => {
    // GIVEN an adapter pointed at an endpoint that is not listening
    // WHEN an object is deleted
    const removed = unreachable.delete("a/b.json");

    // THEN the idempotence of delete does not extend to an unreachable store
    await expect(removed).toBeErrWith(
      expect.objectContaining({ operation: "delete", key: "a/b.json" }),
    );
  });

  it("answers StorageUnavailable when the credentials will not resolve", async ({
    uncredentialed,
  }) => {
    // GIVEN an adapter whose credential provider rejects
    // WHEN a url is asked for — the one operation that never leaves the
    // process, and so the one an unreachable endpoint cannot fail
    const url = uncredentialed.presignedUrl("a/b.json", { ttlMs: 60_000 });

    // THEN signing itself failed, and said so
    await expect(url).toBeErrWith(
      expect.objectContaining({ operation: "presignedUrl", key: "a/b.json" }),
    );
  });
});
