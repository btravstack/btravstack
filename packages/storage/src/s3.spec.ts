import { createHash } from "node:crypto";

import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect } from "vitest";

import { aDocument, it } from "./__tests__/test-fixtures.js";
import { s3StorageBackend } from "./s3.js";

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha256Base64 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("base64");

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

  it("mints a url that writes the object without credentials", async ({ s3, keyPrefix }) => {
    // GIVEN a url signed for exactly this document
    const document = aDocument();
    const url = await s3.presignedUpload(`${keyPrefix}up.json`, {
      ttlMs: 60_000,
      contentType: document.contentType,
      contentLength: document.bytes.byteLength,
    });

    // WHEN a plain fetch carrying no credentials PUTs the bytes at it
    const response = await fetch(url.getOrThrow(), {
      method: "PUT",
      headers: { "content-type": document.contentType },
      body: document.bytes,
    });

    // THEN the store took them, and the object is readable through the port —
    // which is the whole point: the bytes never passed through this process
    await expect(
      s3.get(`${keyPrefix}up.json`).map((object) => ({
        status: response.status,
        bytes: object.bytes,
        contentType: object.contentType,
      })),
    ).toBeOkWith({ status: 200, bytes: document.bytes, contentType: "application/json" });
  });

  it("allows a signed upload url to replace the object until it expires", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN two different equal-length bodies and one signed upload URL
    const key = `${keyPrefix}replayed.json`;
    const first = aDocument();
    const second = new TextEncoder().encode(`{"ok":null}`);
    const url = (
      await s3.presignedUpload(key, {
        ttlMs: 60_000,
        contentType: first.contentType,
        contentLength: first.bytes.byteLength,
      })
    ).getOrThrow();

    const upload = (bytes: Uint8Array) =>
      fetch(url, {
        method: "PUT",
        headers: { "content-type": first.contentType },
        body: bytes,
      });

    // WHEN the same URL is used twice
    const firstResponse = await upload(first.bytes);
    const secondResponse = await upload(second);

    // THEN the second body replaces the first under the same key
    await expect(
      s3.get(key).map((object) => ({
        firstStatus: firstResponse.status,
        secondStatus: secondResponse.status,
        bytes: object.bytes,
        contentType: object.contentType,
      })),
    ).toBeOkWith({
      firstStatus: 200,
      secondStatus: 200,
      bytes: second,
      contentType: first.contentType,
    });
  });

  it("refuses a write whose size is not the one it signed", async ({ s3, keyPrefix }) => {
    // GIVEN a url signed for a one-byte object
    const url = await s3.presignedUpload(`${keyPrefix}short.bin`, {
      ttlMs: 60_000,
      contentType: "application/octet-stream",
      contentLength: 1,
    });

    // WHEN a client PUTs more than it declared
    const response = await fetch(url.getOrThrow(), {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    // THEN the store rejects it and stored nothing — the signed length is the
    // ceiling, enforced by the store rather than trusted from the client
    const stored = await s3.get(`${keyPrefix}short.bin`);
    expect({ status: response.status, stored: stored.isOk() }).toEqual({
      status: 403,
      stored: false,
    });
  });

  it("refuses a write whose type is not the one it signed", async ({ s3, keyPrefix }) => {
    // GIVEN a url signed for a JSON document
    const document = aDocument();
    const url = await s3.presignedUpload(`${keyPrefix}typed.json`, {
      ttlMs: 60_000,
      contentType: document.contentType,
      contentLength: document.bytes.byteLength,
    });

    // WHEN a client PUTs exactly that many bytes under another type
    const response = await fetch(url.getOrThrow(), {
      method: "PUT",
      headers: { "content-type": "text/html" },
      body: document.bytes,
    });

    // THEN the store rejects it and stored nothing — the size alone would have
    // passed, so only the signed type can have refused it
    const stored = await s3.get(`${keyPrefix}typed.json`);
    expect({ status: response.status, stored: stored.isOk() }).toEqual({
      status: 403,
      stored: false,
    });
  });
});

describe("s3Storage, server-side copy, head and checksums", () => {
  it("copies an object inside the store, keeping the bytes and setting the type", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a stored JSON document, under a key that needs URL encoding
    const document = aDocument();
    const from = `${keyPrefix}from é.json`;
    await s3.put(from, document.bytes, { contentType: document.contentType });

    // WHEN it is copied under another type
    const read = s3
      .copy(from, `${keyPrefix}to.bin`, { contentType: "application/octet-stream" })
      .flatMap(() => s3.get(`${keyPrefix}to.bin`));

    // THEN the bytes are the source's and the type is the one given
    await expect(read).toBeOkWith({
      bytes: document.bytes,
      contentType: "application/octet-stream",
    });
  });

  it("answers ObjectNotFound naming the source when copying a missing key", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN nothing under this prefix
    // WHEN an absent key is copied
    const copied = s3.copy(`${keyPrefix}absent.json`, `${keyPrefix}to.json`, {
      contentType: "application/json",
    });

    // THEN it is a modeled absence of the source
    await expect(copied).toBeErrWith(expect.objectContaining({ key: `${keyPrefix}absent.json` }));
  });

  it("heads an object with its size and type, and no sha256 when none was supplied", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a document put without a checksum
    const document = aDocument();
    await s3.put(`${keyPrefix}h.json`, document.bytes, { contentType: document.contentType });

    // WHEN it is headed
    const head = await s3.head(`${keyPrefix}h.json`);

    // THEN size and type come back and no sha256 is invented
    expect(head.getOrThrow()).toEqual({ size: 11, contentType: "application/json" });
  });

  it("answers ObjectNotFound when heading a missing key", async ({ s3, keyPrefix }) => {
    // GIVEN nothing under this prefix
    // WHEN an absent key is headed
    const head = s3.head(`${keyPrefix}absent.json`);

    // THEN the store's 404 is a modeled absence
    await expect(head).toBeErrWith(expect.objectContaining({ key: `${keyPrefix}absent.json` }));
  });

  it("accepts the signed bytes, and heads them with their sha256 in hex", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN an upload url signed with the digest of a document
    const document = aDocument();
    const url = await s3.presignedUpload(`${keyPrefix}c.json`, {
      ttlMs: 60_000,
      contentType: document.contentType,
      contentLength: document.bytes.byteLength,
      sha256: sha256Hex(document.bytes),
    });

    // WHEN the client PUTs those bytes with the checksum header
    const response = await fetch(url.getOrThrow(), {
      method: "PUT",
      headers: {
        "content-type": document.contentType,
        "x-amz-checksum-sha256": sha256Base64(document.bytes),
      },
      body: document.bytes,
    });

    // THEN the store took them and head answers the same digest in hex
    await expect(
      s3.head(`${keyPrefix}c.json`).map((head) => ({ status: response.status, ...head })),
    ).toBeOkWith({
      status: 200,
      size: 11,
      contentType: "application/json",
      sha256: sha256Hex(document.bytes),
    });
  });

  it("refuses other bytes than the signed digest", async ({ s3, keyPrefix }) => {
    // GIVEN an upload url signed with the digest of a document
    const document = aDocument();
    const other = new TextEncoder().encode(`{"ok":null}`);
    const url = await s3.presignedUpload(`${keyPrefix}x.json`, {
      ttlMs: 60_000,
      contentType: document.contentType,
      contentLength: other.byteLength,
      sha256: sha256Hex(document.bytes),
    });

    // WHEN a client sends other bytes of the same size, under the signed header
    const response = await fetch(url.getOrThrow(), {
      method: "PUT",
      headers: {
        "content-type": document.contentType,
        "x-amz-checksum-sha256": sha256Base64(document.bytes),
      },
      body: other,
    });

    // THEN the store refuses them and stored nothing
    const stored = await s3.get(`${keyPrefix}x.json`);
    expect({ refused: response.status >= 400, stored: stored.isOk() }).toEqual({
      refused: true,
      stored: false,
    });
  });

  it("refuses a client that swaps the checksum header for the digest of its own bytes", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN an upload url signed with the digest of a document
    const document = aDocument();
    const other = new TextEncoder().encode(`{"ok":null}`);
    const url = await s3.presignedUpload(`${keyPrefix}y.json`, {
      ttlMs: 60_000,
      contentType: document.contentType,
      contentLength: other.byteLength,
      sha256: sha256Hex(document.bytes),
    });

    // WHEN a client sends other bytes with their own, consistent digest
    const response = await fetch(url.getOrThrow(), {
      method: "PUT",
      headers: {
        "content-type": document.contentType,
        "x-amz-checksum-sha256": sha256Base64(other),
      },
      body: other,
    });

    // THEN the signature no longer matches and nothing is stored
    const stored = await s3.get(`${keyPrefix}y.json`);
    expect({ refused: response.status >= 400, stored: stored.isOk() }).toEqual({
      refused: true,
      stored: false,
    });
  });

  it("sends the SSE-KMS key on put, putIfAbsent and copy, and none when no key is named", async () => {
    // GIVEN a client whose commands are captured at the SDK boundary, since
    // the real store has no KMS to encrypt with
    const sent: Record<string, unknown>[] = [];
    const client = new S3Client({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "none", secretAccessKey: "none" },
    });
    client.middlewareStack.add(
      (_next) => async (args) => {
        sent.push(args.input as Record<string, unknown>);
        return { output: { $metadata: {} }, response: {} };
      },
      { step: "deserialize", name: "capture" },
    );
    const backend = s3StorageBackend(client, "bucket");
    const bytes = new Uint8Array([1]);

    // WHEN the three writes name a key, and one write does not
    await backend.put("a", bytes, { contentType: "t", kmsKeyId: "key-1" });
    await backend.putIfAbsent("b", bytes, { contentType: "t", kmsKeyId: "key-2" });
    await backend.copy("a", "c", { contentType: "t", kmsKeyId: "key-3" });
    await backend.put("d", bytes, { contentType: "t" });

    // THEN the encryption rides the command of each, and is absent when not asked for
    expect(
      sent.map((input) => ({
        key: input["Key"],
        sse: input["ServerSideEncryption"],
        kms: input["SSEKMSKeyId"],
      })),
    ).toEqual([
      { key: "a", sse: "aws:kms", kms: "key-1" },
      { key: "b", sse: "aws:kms", kms: "key-2" },
      { key: "c", sse: "aws:kms", kms: "key-3" },
      { key: "d", sse: undefined, kms: undefined },
    ]);
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

  it("answers StorageUnavailable when an upload url cannot be signed either", async ({
    uncredentialed,
  }) => {
    // GIVEN an adapter whose credential provider rejects
    // WHEN an upload url is asked for
    const url = uncredentialed.presignedUpload("a/b.json", {
      ttlMs: 60_000,
      contentType: "application/json",
      contentLength: 11,
    });

    // THEN signing failed the same way, naming its own operation
    await expect(url).toBeErrWith(
      expect.objectContaining({ operation: "presignedUpload", key: "a/b.json" }),
    );
  });

  it("writes on the first putIfAbsent and refuses the second, keeping the first bytes", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a key nobody holds
    const key = `${keyPrefix}once.json`;
    const first = aDocument();
    const second = new TextEncoder().encode(`{"ok":false}`);

    // WHEN two conditional puts follow on that key
    const firstWrite = await s3.putIfAbsent(key, first.bytes, { contentType: first.contentType });
    const secondWrite = await s3.putIfAbsent(key, second, { contentType: first.contentType });

    // THEN the first wrote, the second met ObjectExists, and the first bytes remain
    expect({
      first: firstWrite.tag,
      second: secondWrite.tag === "Err" ? secondWrite.error._tag : secondWrite.tag,
      stored: (await s3.get(key)).getOrThrow().bytes,
    }).toEqual({ first: "Ok", second: "ObjectExists", stored: first.bytes });
  });

  it("lets exactly one of two concurrent putIfAbsent win", async ({ s3, keyPrefix }) => {
    // GIVEN a key nobody holds
    const key = `${keyPrefix}once.json`;
    const document = aDocument();

    // WHEN two conditional puts race on it
    const settled = await Promise.all([
      s3.putIfAbsent(key, document.bytes, { contentType: document.contentType }),
      s3.putIfAbsent(key, document.bytes, { contentType: document.contentType }),
    ]);

    // THEN one is Ok and the other ObjectExists
    expect(
      settled.map((result) => (result.tag === "Err" ? result.error._tag : result.tag)).sort(),
    ).toEqual(["ObjectExists", "Ok"]);
  });

  it("answers StorageUnavailable when the store cannot be reached for a putIfAbsent", async ({
    unreachable,
  }) => {
    // GIVEN an endpoint that is not listening
    // WHEN a conditional put is attempted
    const written = unreachable.putIfAbsent("a/b.json", new Uint8Array([1]), {
      contentType: "application/json",
    });

    // THEN it is an outage, not a held key
    await expect(written).toBeErrWith(
      expect.objectContaining({ operation: "putIfAbsent", key: "a/b.json" }),
    );
  });

  it("answers StorageUnavailable naming copy and head when the store cannot be reached", async ({
    unreachable,
  }) => {
    // GIVEN an endpoint that is not listening
    // WHEN a copy and a head are attempted
    const copied = unreachable.copy("a", "b", { contentType: "application/json" });
    const head = unreachable.head("a");

    // THEN each is an outage naming its own operation
    await expect(copied).toBeErrWith(expect.objectContaining({ operation: "copy", key: "a" }));
    await expect(head).toBeErrWith(expect.objectContaining({ operation: "head", key: "a" }));
  });
});
