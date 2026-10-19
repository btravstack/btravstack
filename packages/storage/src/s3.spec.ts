import { createHash } from "node:crypto";

import { ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import { P, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { MiB, aDocument, aStream, digestOf, it, peakGrowth } from "./__tests__/test-fixtures.js";
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
    await expect(copied).toBeErrWith(
      expect.objectContaining({ _tag: "ObjectNotFound", key: `${keyPrefix}absent.json` }),
    );
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
    expect(head.getOrThrow()).toEqual({ metadata: {}, size: 11, contentType: "application/json" });
  });

  it("answers ObjectNotFound when heading a missing key", async ({ s3, keyPrefix }) => {
    // GIVEN nothing under this prefix
    // WHEN an absent key is headed
    const head = s3.head(`${keyPrefix}absent.json`);

    // THEN the store's 404 is a modeled absence
    await expect(head).toBeErrWith(
      expect.objectContaining({ _tag: "ObjectNotFound", key: `${keyPrefix}absent.json` }),
    );
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
      metadata: {},
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
        tagging: input["TaggingDirective"],
        annotation: input["AnnotationDirective"],
      })),
    ).toEqual([
      { key: "a", sse: "aws:kms", kms: "key-1", tagging: undefined, annotation: undefined },
      { key: "b", sse: "aws:kms", kms: "key-2", tagging: undefined, annotation: undefined },
      { key: "c", sse: "aws:kms", kms: "key-3", tagging: "REPLACE", annotation: "EXCLUDE" },
      { key: "d", sse: undefined, kms: undefined, tagging: undefined, annotation: undefined },
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

  it("answers StorageUnavailable naming copy when the store cannot be reached", async ({
    unreachable,
  }) => {
    // GIVEN an endpoint that is not listening
    // WHEN a copy is attempted
    const copied = unreachable.copy("a", "b", { contentType: "application/json" });

    // THEN it is an outage naming copy
    await expect(copied).toBeErrWith(expect.objectContaining({ operation: "copy", key: "a" }));
  });

  it("answers StorageUnavailable naming head when the store cannot be reached", async ({
    unreachable,
  }) => {
    // GIVEN an endpoint that is not listening
    // WHEN a head is attempted
    const head = unreachable.head("a");

    // THEN it is an outage naming head
    await expect(head).toBeErrWith(expect.objectContaining({ operation: "head", key: "a" }));
  });

  it("answers StorageUnavailable, not a throw, for a copy source that cannot be encoded", async ({
    unreachable,
  }) => {
    // GIVEN a key holding an unpaired surrogate, which encodeURIComponent refuses
    // WHEN it is copied
    const copied = unreachable.copy("\ud800", "b", { contentType: "application/json" });

    // THEN the refusal is a modeled outage rather than an exception
    await expect(copied).toBeErrWith(expect.objectContaining({ operation: "copy" }));
  });
});

// Tens of MiB against the RustFS the whole gate shares, under turbo's concurrency.
describe("s3Storage, streamed", { timeout: 60_000 }, () => {
  it("round-trips a stream longer than one part, with its type and size", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a 20 MiB stream, three parts of a multipart upload
    const key = `${keyPrefix}large.bin`;

    // WHEN it is written as it streams, and read back the same way
    const read = await s3
      .putStream(key, aStream(20 * MiB), { contentType: "application/octet-stream" })
      .flatMap(() => s3.getStream(key))
      .flatMap(({ stream, contentType, size }) =>
        fromSafePromise(digestOf(stream)).map((digest) => ({ contentType, size, read: digest })),
      );

    // THEN every byte came back, in order
    expect(read.getOrThrow()).toEqual({
      contentType: "application/octet-stream",
      size: 20 * MiB,
      read: await digestOf(aStream(20 * MiB)),
    });
  });

  it("writes a stream shorter than one part as one object", async ({ s3, keyPrefix }) => {
    // GIVEN a stream well under one part
    const key = `${keyPrefix}small.json`;
    const document = aDocument();

    // WHEN it is written as it streams
    const read = s3
      .putStream(key, new Blob([Uint8Array.from(document.bytes)]).stream(), {
        contentType: document.contentType,
      })
      .flatMap(() => s3.get(key));

    // THEN the plain read answers it whole
    await expect(read).toBeOkWith({ bytes: document.bytes, contentType: "application/json" });
  });

  it("heads a streamed object with its metadata, and no sha256", async ({ s3, keyPrefix }) => {
    // GIVEN a multipart write with a verified digest and metadata
    const key = `${keyPrefix}described.bin`;
    const { sha256 } = await digestOf(aStream(9 * MiB));

    // WHEN it is headed
    const head = s3
      .putStream(key, aStream(9 * MiB), {
        contentType: "application/pdf",
        sha256,
        metadata: { origin: "stream" },
      })
      .flatMap(() => s3.head(key));

    // THEN the store kept the description, and no full-object digest
    await expect(head).toBeOkWith({
      size: 9 * MiB,
      contentType: "application/pdf",
      metadata: { origin: "stream" },
    });
  });

  it("answers StreamInterrupted, carrying the source's error, when the source fails midway", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a source that breaks after its first part has been uploaded
    const key = `${keyPrefix}broken.bin`;

    // WHEN it is written
    const written = s3.putStream(key, aStream(20 * MiB, { failingAt: 12 * MiB }), {
      contentType: "application/octet-stream",
    });

    // THEN the caller hears its own stream's failure, not the store's
    await expect(written).toBeErrWith(
      expect.objectContaining({
        _tag: "StreamInterrupted",
        key,
        cause: expect.objectContaining({ message: "the source broke" }),
      }),
    );
  });

  it("leaves no object when the source fails midway", async ({ s3, keyPrefix }) => {
    // GIVEN a source that breaks after its first part has been uploaded
    const key = `${keyPrefix}broken.bin`;

    // WHEN it is written, then looked for
    const head = s3
      .putStream(key, aStream(20 * MiB, { failingAt: 12 * MiB }), {
        contentType: "application/octet-stream",
      })
      .flatMapErrCases((matcher) =>
        matcher.with(
          P.tag("StreamInterrupted"),
          P.tag("InvalidStorageOptions"),
          P.tag("ChecksumMismatch"),
          P.tag("StorageUnavailable"),
          () => s3.head(key),
        ),
      );

    // THEN nothing is there
    await expect(head).toBeErrTagged("ObjectNotFound");
  });

  it("aborts the multipart upload when the source fails midway", async ({
    s3,
    keyPrefix,
    rustfs,
    bucket,
  }) => {
    // GIVEN a source that breaks after its first part has been uploaded
    const key = `${keyPrefix}broken.bin`;
    await s3.putStream(key, aStream(20 * MiB, { failingAt: 12 * MiB }), {
      contentType: "application/octet-stream",
    });

    // WHEN the store is asked what is still being uploaded under the key
    const listed = await rustfs.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );

    // THEN nothing: the parts went with the abort
    expect(listed.Uploads ?? []).toEqual([]);
  });

  it("refuses a multipart stream whose bytes do not match its sha256, and stores nothing", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a stream and the digest of another
    const key = `${keyPrefix}forged.bin`;
    const { sha256 } = await digestOf(aStream(10 * MiB));

    // WHEN it is written under that digest
    const written = await s3.putStream(key, aStream(9 * MiB), {
      contentType: "application/octet-stream",
      sha256,
    });

    // THEN it is refused before the object is completed, and nothing is there
    expect({
      written: written.isErr() ? written.error._tag : written.tag,
      stored: (await s3.head(key)).isOk(),
    }).toEqual({ written: "ChecksumMismatch", stored: false });
  });

  it("refuses a one-part stream whose bytes do not match its sha256, and stores nothing", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a short stream and the digest of another
    const key = `${keyPrefix}forged.json`;
    const { sha256 } = await digestOf(aStream(2));

    // WHEN it is written under that digest
    const written = await s3.putStream(key, aStream(1), {
      contentType: "application/json",
      sha256,
    });

    // THEN it is refused, and nothing is there
    expect({
      written: written.isErr() ? written.error._tag : written.tag,
      stored: (await s3.head(key)).isOk(),
    }).toEqual({ written: "ChecksumMismatch", stored: false });
  });

  it("refuses invalid options before reading, and cancels the stream", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a stream that reports its cancel
    let cancelled: unknown;
    const stream = aStream(MiB, { cancelled: (reason) => (cancelled = reason) });

    // WHEN it is written under a malformed digest
    await s3.putStream(`${keyPrefix}x.bin`, stream, {
      contentType: "application/octet-stream",
      sha256: "nope",
    });

    // THEN the source was released, with the refusal as its reason
    expect(cancelled).toEqual(
      expect.objectContaining({ _tag: "InvalidStorageOptions", reason: "invalid_sha256" }),
    );
  });

  it("writes on the first putStreamIfAbsent and refuses the second, keeping the first bytes", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a key a multipart stream already holds
    const key = `${keyPrefix}once.bin`;
    const options = { contentType: "application/octet-stream" };

    // WHEN a second, different stream is written to it conditionally
    const second = await s3
      .putStreamIfAbsent(key, aStream(9 * MiB), options)
      .flatMap(() => s3.putStreamIfAbsent(key, aStream(10 * MiB), options));
    const stored = await s3
      .getStream(key)
      .flatMap(({ stream }) => fromSafePromise(digestOf(stream)));

    // THEN the second is refused at completion and the first is what remains
    expect({
      second: second.isErr() ? second.error._tag : second.tag,
      stored: stored.getOrThrow(),
    }).toEqual({ second: "ObjectExists", stored: await digestOf(aStream(9 * MiB)) });
  });

  it("refuses a one-part putStreamIfAbsent on a held key", async ({ s3, keyPrefix }) => {
    // GIVEN a held key
    const key = `${keyPrefix}once.json`;
    const document = aDocument();

    // WHEN a short stream is written to it conditionally
    const second = s3
      .put(key, document.bytes, { contentType: document.contentType })
      .flatMap(() => s3.putStreamIfAbsent(key, aStream(1), { contentType: document.contentType }));

    // THEN the store refused it
    await expect(second).toBeErrTagged("ObjectExists");
  });

  it("aborts the losing multipart upload of a putStreamIfAbsent", async ({
    s3,
    keyPrefix,
    rustfs,
    bucket,
  }) => {
    // GIVEN a key a stream already holds
    const key = `${keyPrefix}once.bin`;
    const options = { contentType: "application/octet-stream" };
    await s3
      .putStreamIfAbsent(key, aStream(9 * MiB), options)
      .flatMap(() => s3.putStreamIfAbsent(key, aStream(9 * MiB), options));

    // WHEN the store is asked what is still being uploaded under the key
    const listed = await rustfs.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
    );

    // THEN the refused upload was aborted rather than left to the lifecycle rule
    expect(listed.Uploads ?? []).toEqual([]);
  });

  it("lets exactly one of two concurrent putStreamIfAbsent win", async ({ s3, keyPrefix }) => {
    // GIVEN a key nobody holds
    const key = `${keyPrefix}race.bin`;
    const options = { contentType: "application/octet-stream" };

    // WHEN two multipart streams race on it
    const settled = await Promise.all([
      s3.putStreamIfAbsent(key, aStream(9 * MiB), options),
      s3.putStreamIfAbsent(key, aStream(9 * MiB), options),
    ]);

    // THEN one is Ok and the other ObjectExists
    expect(
      settled.map((result) => (result.isErr() ? result.error._tag : result.tag)).sort(),
    ).toEqual(["ObjectExists", "Ok"]);
  });

  it("answers ObjectNotFound when streaming a key nobody stored", async ({ s3, keyPrefix }) => {
    // GIVEN nothing under this prefix
    // WHEN an absent key is streamed
    const read = s3.getStream(`${keyPrefix}absent.bin`);

    // THEN it is the modeled absence, as for get
    await expect(read).toBeErrWith(
      expect.objectContaining({ _tag: "ObjectNotFound", key: `${keyPrefix}absent.bin` }),
    );
  });

  it("writes 256 MiB without holding it in memory", async ({ s3, keyPrefix }) => {
    // GIVEN a 256 MiB source
    const key = `${keyPrefix}huge.bin`;

    // WHEN it is written as it streams
    const { value, growth } = await peakGrowth(() =>
      s3.putStream(key, aStream(256 * MiB), { contentType: "application/octet-stream" }),
    );

    // THEN memory held a few parts at most, never the object
    expect({ written: value.isOk(), bounded: growth < 128 * MiB }).toEqual({
      written: true,
      bounded: true,
    });
  });

  it("reads 256 MiB without holding it in memory", async ({ s3, keyPrefix }) => {
    // GIVEN a stored 256 MiB object
    const key = `${keyPrefix}huge.bin`;
    await s3.putStream(key, aStream(256 * MiB), { contentType: "application/octet-stream" });

    // WHEN it is read as it streams
    const { value, growth } = await peakGrowth(async () =>
      s3
        .getStream(key)
        .flatMap(({ stream }) => fromSafePromise(digestOf(stream)))
        .then((digest) => digest.getOrThrow()),
    );

    // THEN memory held a few chunks at most, never the object
    expect({ read: value.size, bounded: growth < 128 * MiB }).toEqual({
      read: 256 * MiB,
      bounded: true,
    });
  });

  it("sends the SSE-KMS key on a streamed write, one part or several", async () => {
    // GIVEN a client whose commands are captured at the SDK boundary
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

    // WHEN a short and a long stream name a key
    await backend.putStream("a", aStream(1), { contentType: "t", kmsKeyId: "key-1" });
    await backend.putStreamIfAbsent("b", aStream(9 * MiB), { contentType: "t", kmsKeyId: "key-2" });

    // THEN the encryption rides the write that creates each object
    expect(
      sent
        .filter((input) => input["ServerSideEncryption"] !== undefined)
        .map((input) => ({
          key: input["Key"],
          kms: input["SSEKMSKeyId"],
          part: input["PartNumber"],
        })),
    ).toEqual([
      { key: "a", kms: "key-1", part: undefined },
      { key: "b", kms: "key-2", part: undefined },
    ]);
  });
});

describe("s3Storage, streamed, when the store cannot be reached", () => {
  it("answers StorageUnavailable naming putStream", async ({ unreachable }) => {
    // GIVEN an endpoint that is not listening
    // WHEN a stream is written
    const written = unreachable.putStream("a.bin", aStream(1), { contentType: "t" });

    // THEN the failure names the operation
    await expect(written).toBeErrWith(
      expect.objectContaining({ operation: "putStream", key: "a.bin" }),
    );
  });

  it("answers StorageUnavailable naming putStreamIfAbsent, and cancels the stream", async ({
    unreachable,
  }) => {
    // GIVEN a stream longer than a part, which reports its cancel
    let cancelled: unknown;
    const stream = aStream(20 * MiB, { cancelled: (reason) => (cancelled = reason) });

    // WHEN it is written while the store is down
    await unreachable.putStreamIfAbsent("a.bin", stream, { contentType: "t" });

    // THEN the rest of the source was released, with the store's failure as its reason
    expect(cancelled).toEqual(
      expect.objectContaining({ _tag: "StorageUnavailable", operation: "putStreamIfAbsent" }),
    );
  });

  it("answers StorageUnavailable naming getStream", async ({ unreachable }) => {
    // GIVEN an endpoint that is not listening
    // WHEN a key is streamed
    const read = unreachable.getStream("a.bin");

    // THEN it is not called missing
    await expect(read).toBeErrWith(
      expect.objectContaining({ operation: "getStream", key: "a.bin" }),
    );
  });
});
