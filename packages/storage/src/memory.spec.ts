import { describe, expect } from "vitest";

import { aDocument, it } from "./__tests__/test-fixtures.js";

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

  it("refuses to sign an upload for the same reason", async ({ memory }) => {
    // GIVEN nothing stored — signing asks the store nothing either way
    // WHEN a url to write against is asked for
    const url = memory.presignedUpload("a/b.json", {
      ttlMs: 60_000,
      contentType: "application/json",
      contentLength: 11,
    });

    // THEN the adapter says it cannot, so an application built on the
    // presigned flow fails here rather than uploading into a fiction
    await expect(url).toBeErrWith(expect.objectContaining({ key: "a/b.json" }));
  });

  it("writes on the first putIfAbsent and refuses the second, keeping the first bytes", async ({
    memory,
  }) => {
    // GIVEN a key nobody holds
    const key = "a/once.json";
    const first = aDocument();
    const second = new TextEncoder().encode(`{"ok":false}`);

    // WHEN two conditional puts follow on that key
    const firstWrite = await memory.putIfAbsent(key, first.bytes, {
      contentType: first.contentType,
    });
    const secondWrite = await memory.putIfAbsent(key, second, { contentType: first.contentType });

    // THEN the first wrote, the second met ObjectExists, and the first bytes remain
    expect({
      first: firstWrite.tag,
      second: secondWrite.tag === "Err" ? secondWrite.error._tag : secondWrite.tag,
      stored: (await memory.get(key)).getOrThrow().bytes,
    }).toEqual({ first: "Ok", second: "ObjectExists", stored: first.bytes });
  });

  it("lets exactly one of two concurrent putIfAbsent win", async ({ memory }) => {
    // GIVEN a key nobody holds
    const key = "a/once.json";
    const document = aDocument();

    // WHEN two conditional puts race on it
    const settled = await Promise.all([
      memory.putIfAbsent(key, document.bytes, { contentType: document.contentType }),
      memory.putIfAbsent(key, document.bytes, { contentType: document.contentType }),
    ]);

    // THEN one is Ok and the other ObjectExists
    expect(
      settled.map((result) => (result.tag === "Err" ? result.error._tag : result.tag)).sort(),
    ).toEqual(["ObjectExists", "Ok"]);
  });

  it("copies an object under a new key with the type given", async ({ memory }) => {
    // GIVEN a stored document
    const document = aDocument();
    await memory.put("a/b.json", document.bytes, { contentType: document.contentType });

    // WHEN it is copied with another type
    const read = memory
      .copy("a/b.json", "c/d.bin", { contentType: "application/octet-stream" })
      .flatMap(() => memory.get("c/d.bin"));

    // THEN the bytes are the source's and the type is the one asked for
    await expect(read).toBeOkWith({
      bytes: document.bytes,
      contentType: "application/octet-stream",
    });
  });

  it("answers ObjectNotFound naming the source when copying a missing key", async ({ memory }) => {
    // GIVEN nothing stored
    // WHEN an absent key is copied
    const copied = memory.copy("absent", "c/d.bin", { contentType: "application/json" });

    // THEN the source is named
    await expect(copied).toBeErrWith(expect.objectContaining({ key: "absent" }));
  });

  it("heads an object with its size, type and sha256", async ({ memory }) => {
    // GIVEN a stored document
    const document = aDocument();
    await memory.put("a/b.json", document.bytes, { contentType: document.contentType });

    // WHEN it is headed
    const head = memory.head("a/b.json");

    // THEN the size, the type and the hex digest of the bytes come back
    await expect(head).toBeOkWith({
      size: 11,
      contentType: "application/json",
      sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
    });
  });

  it("answers ObjectNotFound when heading a missing key", async ({ memory }) => {
    // GIVEN nothing stored
    // WHEN an absent key is headed
    const head = memory.head("absent");

    // THEN it is a modeled absence
    await expect(head).toBeErrWith(expect.objectContaining({ key: "absent" }));
  });
});
