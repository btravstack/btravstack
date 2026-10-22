import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout } from "node:timers/promises";

import { ListMultipartUploadsCommand, S3Client } from "@aws-sdk/client-s3";
import { P, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";

import { MiB, aDocument, aStream, digestOf, it, peakGrowth } from "./__tests__/test-fixtures.js";
import { s3StorageBackend } from "./s3.js";
import { StreamPoolFull } from "./storage.js";

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

  it("serves signed response overrides including a unicode filename", async ({ s3, keyPrefix }) => {
    // GIVEN a stored document and an RFC 8187 filename
    const key = `${keyPrefix}download`;
    const disposition = "attachment; filename=report.pdf; filename*=UTF-8''relev%C3%A9.pdf";
    const url = await s3
      .put(key, aDocument().bytes, { contentType: "application/json" })
      .flatMap(() =>
        s3.presignedUrl(key, {
          ttlMs: 60_000,
          contentDisposition: disposition,
          contentType: "application/pdf",
          cacheControl: "private, no-store",
        }),
      );

    // WHEN the signed download is fetched
    const response = await fetch(url.getOrThrow());
    await response.arrayBuffer();

    // THEN the response carries the requested headers
    expect({
      status: response.status,
      disposition: response.headers.get("content-disposition"),
      type: response.headers.get("content-type"),
      cache: response.headers.get("cache-control"),
    }).toEqual({ status: 200, disposition, type: "application/pdf", cache: "private, no-store" });
  });

  it("keeps stored metadata unchanged when a download overrides it", async ({ s3, keyPrefix }) => {
    // GIVEN an object with its own content type
    const key = `${keyPrefix}unchanged`;
    await s3.put(key, aDocument().bytes, { contentType: "application/json" }).getOrThrow();

    // WHEN a download overrides its response type
    await s3.presignedUrl(key, { ttlMs: 60_000, contentType: "application/pdf" }).getOrThrow();

    // THEN the stored description is unchanged
    await expect(s3.head(key)).toBeOkWith(
      expect.objectContaining({ contentType: "application/json" }),
    );
  });

  it.for([
    ["response-content-disposition", "inline"],
    ["response-content-type", "text/plain"],
    ["response-cache-control", "public"],
  ] as const)(
    "refuses a changed %s override",
    async ([parameter, replacement], { s3, keyPrefix }) => {
      // GIVEN a download signed with response overrides
      const key = `${keyPrefix}download`;
      const signed = await s3
        .put(key, aDocument().bytes, { contentType: "application/json" })
        .flatMap(() =>
          s3.presignedUrl(key, {
            ttlMs: 60_000,
            contentDisposition: "attachment",
            contentType: "application/pdf",
            cacheControl: "private",
          }),
        );
      const url = new URL(signed.getOrThrow());
      url.searchParams.set(parameter, replacement);

      // WHEN an override is changed without signing again
      const response = await fetch(url);
      await response.arrayBuffer();

      // THEN the store refuses the signature
      expect(response.status).toBe(403);
    },
  );

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
          P.tag("StreamPoolFull"),
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

  it("checks sha256 against the bytes it sends, even when the producer mutates a chunk it enqueued", async ({
    s3,
    keyPrefix,
  }) => {
    // GIVEN a producer that rewrites its first chunk after handing it over,
    // and the digest of the bytes it first handed over
    const key = `${keyPrefix}mutated.bin`;
    const first = new Uint8Array(65_536).fill(1);
    const second = new Uint8Array(65_536).fill(3);
    const { sha256 } = await digestOf(new Blob([first.slice(), second]).stream());
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulls += 1;
        if (pulls === 1) controller.enqueue(first);
        else if (pulls === 2) controller.enqueue(second);
        else {
          first.fill(2);
          controller.close();
        }
      },
    });

    // WHEN it is written under that digest
    const written = await s3.putStream(key, source, { contentType: "t", sha256 });

    // THEN the digest covered what would have been stored, so nothing is
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

  it("cuts a chunk larger than a part across parts", async () => {
    // GIVEN a client whose commands are captured at the SDK boundary, and a
    // source that sends 20 MiB as one chunk
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
        return { output: { $metadata: {}, UploadId: "u", ETag: "e" } as never, response: {} };
      },
      { step: "initialize", name: "capture" },
    );
    const chunk = new Uint8Array(20 * MiB);
    const source = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(chunk);
        controller.close();
      },
    });

    // WHEN it is written as it streams
    await s3StorageBackend(client, "bucket").putStream("a", source, { contentType: "t" });

    // THEN no part is larger than one part's size
    expect(
      sent
        .filter((input) => input["PartNumber"] !== undefined)
        .map((input) => (input["Body"] as Uint8Array).byteLength / MiB),
    ).toEqual([8, 8, 4]);
  });

  it("writes a stream of exactly one part as one object", async () => {
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
        return { output: { $metadata: {} } as never, response: {} };
      },
      { step: "initialize", name: "capture" },
    );

    // WHEN a stream of exactly 8 MiB is written
    await s3StorageBackend(client, "bucket").putStream("a", aStream(8 * MiB), {
      contentType: "t",
    });

    // THEN one command carried it whole, with no multipart upload around it
    expect(
      sent.map((input) => ({
        upload: input["UploadId"],
        size: (input["Body"] as Uint8Array | undefined)?.byteLength,
      })),
    ).toEqual([{ upload: undefined, size: 8 * MiB }]);
  });

  it("reads a refused precondition as an outage on an unconditional putStream", async () => {
    // GIVEN a store that answers 412 to every command, which only a
    // conditional write can have asked for
    const client = new S3Client({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "none", secretAccessKey: "none" },
    });
    client.middlewareStack.add(
      () => () =>
        Promise.reject(
          Object.assign(new Error("precondition"), { $metadata: { httpStatusCode: 412 } }),
        ),
      { step: "initialize", name: "refuse" },
    );

    // WHEN an unconditional stream is written
    const written = s3StorageBackend(client, "bucket").putStream("a", aStream(1), {
      contentType: "t",
    });

    // THEN it is not ObjectExists, which putStream never answers
    await expect(written).toBeErrWith(
      expect.objectContaining({ _tag: "StorageUnavailable", operation: "putStream" }),
    );
  });

  it("answers no size when the store sends no length", async () => {
    // GIVEN a store whose answer carries no ContentLength
    const client = new S3Client({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "none", secretAccessKey: "none" },
    });
    client.middlewareStack.add(
      () => () =>
        Promise.resolve({
          output: {
            $metadata: {},
            Body: Object.assign(Readable.from([]), {
              transformToWebStream: () => new Blob([]).stream(),
            }),
          } as never,
          response: {},
        }),
      { step: "initialize", name: "answer" },
    );

    // WHEN the key is streamed
    const read = s3StorageBackend(client, "bucket")
      .getStream("a")
      .map(({ size, contentType }) => ({ size, contentType }));

    // THEN its size is unknown rather than zero, and the type the honest default
    await expect(read).toBeOkWith({ size: undefined, contentType: "application/octet-stream" });
  });

  it("gives the slot back for a body that closed before the stream was answered", async () => {
    // GIVEN a pool of one, and a store whose body is already destroyed when it answers
    const client = new S3Client({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "none", secretAccessKey: "none" },
    });
    client.middlewareStack.add(
      () => () =>
        Promise.resolve({
          output: {
            $metadata: {},
            Body: Object.assign(Readable.from([]).destroy(), {
              transformToWebStream: () => new Blob([]).stream(),
            }),
          } as never,
          response: {},
        }),
      { step: "initialize", name: "answer" },
    );
    const store = s3StorageBackend(client, "bucket", { client, maxSockets: 1 });

    // WHEN the key is streamed twice, one after the other
    const read = store.getStream("a").flatMap(() => store.getStream("a"));

    // THEN the first left no slot held
    await expect(read).toBeOk();
  });

  it("hands the stream back unlocked once a write has settled", async ({ s3, keyPrefix }) => {
    // GIVEN a stream written to the store
    const stream = aStream(9 * MiB);
    await s3.putStream(`${keyPrefix}released.bin`, stream, { contentType: "t" });

    // WHEN its lock is looked at
    const locked = stream.locked;

    // THEN the adapter released its reader
    expect(locked).toBe(false);
  });

  it("hands a failed stream back unlocked too", async ({ s3, keyPrefix }) => {
    // GIVEN a stream that broke while being written
    const stream = aStream(9 * MiB, { failingAt: MiB });
    await s3.putStream(`${keyPrefix}released.bin`, stream, { contentType: "t" });

    // WHEN its lock is looked at
    const locked = stream.locked;

    // THEN the adapter released its reader
    expect(locked).toBe(false);
  });

  it("answers StreamInterrupted for a stream another reader holds", async ({ s3, keyPrefix }) => {
    // GIVEN a stream already locked to a reader
    const stream = aStream(1);
    stream.getReader();

    // WHEN it is written
    const written = s3.putStream(`${keyPrefix}locked.bin`, stream, { contentType: "t" });

    // THEN the refusal to read it is an answer, not a throw
    await expect(written).toBeErrTagged("StreamInterrupted");
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
    expect({ written: value.isOk(), bounded: growth < 64 * MiB }).toEqual({
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

    // THEN memory held a few chunks at most, never the object — the SDK's
    // response buffering leaves less room here than the write's one part
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

  it("answers the part's failure when the store refuses the abort too", async () => {
    // GIVEN a store that opens a multipart upload, then refuses everything else
    const client = new S3Client({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "none", secretAccessKey: "none" },
    });
    client.middlewareStack.add(
      () => (args) =>
        "PartNumber" in (args.input as object) || "MultipartUpload" in (args.input as object)
          ? Promise.reject(new Error("no route"))
          : (args.input as { UploadId?: string }).UploadId === undefined
            ? Promise.resolve({ output: { $metadata: {}, UploadId: "u" } as never, response: {} })
            : Promise.reject(new Error("no route either")),
      { step: "initialize", name: "refuse" },
    );

    // WHEN a stream longer than a part is written
    const written = s3StorageBackend(client, "bucket").putStream("a", aStream(9 * MiB), {
      contentType: "t",
    });

    // THEN the part's failure is the answer, not the abort's
    await expect(written).toBeErrWith(
      expect.objectContaining({ _tag: "StorageUnavailable", reason: "no route" }),
    );
  });

  it("answers without waiting on a source whose cancel never settles", async ({ unreachable }) => {
    // GIVEN a source whose cancel hangs forever
    const stream = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(65_536)),
      cancel: () => new Promise<void>(() => undefined),
    });

    // WHEN it is written while the store is down
    const written = unreachable.putStream("a.bin", stream, { contentType: "t" });

    // THEN the store's failure is the answer, unheld by the cleanup
    await expect(written).toBeErrTagged("StorageUnavailable");
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

describe("s3Storage, with every stream socket held", { timeout: 60_000 }, () => {
  it("still answers a head and a put while as many streams as the pool holds are open and unread", async ({
    pooled,
    keyPrefix,
  }) => {
    // GIVEN an object larger than what a socket buffers, streamed by as many
    // readers as the stream pool has sockets, none of them reading
    const key = `${keyPrefix}large.bin`;
    const document = aDocument();
    const held = pooled
      .put(key, new Uint8Array(32 * MiB), { contentType: "application/octet-stream" })
      .flatMap(() => pooled.getStream(key))
      .flatMap(() => pooled.getStream(key));

    // WHEN a short call of each kind is made
    const answered = held
      .flatMap(() => pooled.head(key))
      .flatMap(() =>
        pooled.put(`${keyPrefix}small.json`, document.bytes, {
          contentType: document.contentType,
        }),
      )
      .flatMap(() => pooled.head(`${keyPrefix}small.json`));

    // THEN both completed on sockets of their own
    await expect(answered).toBeOkWith(
      expect.objectContaining({ size: document.bytes.byteLength, contentType: "application/json" }),
    );
  });

  it("refuses a stream past the pool's size, naming the bound it read", async ({
    pooled,
    keyPrefix,
  }) => {
    // GIVEN every stream socket held by an unread stream
    const key = `${keyPrefix}large.bin`;
    const held = pooled
      .put(key, new Uint8Array(32 * MiB), { contentType: "application/octet-stream" })
      .flatMap(() => pooled.getStream(key))
      .flatMap(() => pooled.getStream(key));

    // WHEN one more is asked for
    const read = held.flatMap(() => pooled.getStream(key));

    // THEN it is refused at once, with the bound read from STORAGE_S3_STREAM_MAX_SOCKETS
    await expect(read).toBeErrWith(
      expect.objectContaining({
        constructor: StreamPoolFull,
        operation: "getStream",
        key,
        maxSockets: 2,
      }),
    );
  });

  it("refuses a streamed write past the pool's size, and cancels its source", async ({
    pooled,
    keyPrefix,
  }) => {
    // GIVEN every stream socket held by an unread stream, and a source that reports its cancel
    const key = `${keyPrefix}large.bin`;
    let cancelled: unknown;
    const source = aStream(MiB, { cancelled: (reason) => (cancelled = reason) });
    const held = pooled
      .put(key, new Uint8Array(32 * MiB), { contentType: "application/octet-stream" })
      .flatMap(() => pooled.getStream(key))
      .flatMap(() => pooled.getStream(key));

    // WHEN a stream is written
    const written = await held.flatMap(() =>
      pooled.putStreamIfAbsent(`${keyPrefix}refused.bin`, source, {
        contentType: "application/octet-stream",
      }),
    );

    // THEN the write is refused before sending anything, and its source released with the refusal
    expect({
      written: written.isErr() ? written.error : written.tag,
      cancelled,
    }).toEqual({
      written: expect.objectContaining({ operation: "putStreamIfAbsent", maxSockets: 2 }),
      cancelled: expect.objectContaining({ _tag: "StreamPoolFull" }),
    });
  });

  it("gives a socket back once its stream is cancelled or read to its end", async ({
    pooled,
    keyPrefix,
  }) => {
    // GIVEN two streams holding the pool, one then cancelled and one read to its end
    const key = `${keyPrefix}large.bin`;
    const released = pooled
      .put(key, new Uint8Array(32 * MiB), { contentType: "application/octet-stream" })
      .flatMap(() => pooled.getStream(key))
      .flatMap((first) =>
        pooled
          .getStream(key)
          .flatMap((second) =>
            fromSafePromise(first.stream.cancel().then(() => digestOf(second.stream))),
          ),
      );

    // WHEN the pool is filled again, and both are read
    const reread = released
      .flatMap(() => pooled.getStream(key))
      .flatMap((first) =>
        pooled
          .getStream(key)
          .flatMap((second) =>
            fromSafePromise(Promise.all([digestOf(first.stream), digestOf(second.stream)])),
          ),
      );

    // THEN both were answered, on sockets the first two gave back
    await expect(reread.map((reads) => reads.map(({ size }) => size))).toBeOkWith([
      32 * MiB,
      32 * MiB,
    ]);
  });

  it("gives a streamed write's slot back once it settles, failed or written", async ({
    pooled,
    keyPrefix,
  }) => {
    // GIVEN two writes whose sources fail, then two that succeed
    const options = { contentType: "application/octet-stream" };
    const broken = (name: string) =>
      pooled
        .putStream(`${keyPrefix}${name}`, aStream(MiB, { failingAt: 0 }), options)
        .recoverErrCases((matcher) =>
          matcher.with(
            P.tag("StreamInterrupted"),
            P.tag("InvalidStorageOptions"),
            P.tag("ChecksumMismatch"),
            P.tag("StreamPoolFull"),
            P.tag("StorageUnavailable"),
            () => undefined,
          ),
        );
    const settled = broken("a.bin")
      .flatMap(() => broken("b.bin"))
      .flatMap(() => pooled.putStream(`${keyPrefix}c.bin`, aStream(MiB), options))
      .flatMap(() => pooled.putStream(`${keyPrefix}d.bin`, aStream(MiB), options));

    // WHEN the pool is asked for two more streams at once
    const read = settled.flatMap(() =>
      pooled
        .getStream(`${keyPrefix}c.bin`)
        .flatMap((first) =>
          pooled
            .getStream(`${keyPrefix}d.bin`)
            .flatMap((second) =>
              fromSafePromise(Promise.all([digestOf(first.stream), digestOf(second.stream)])),
            ),
        ),
    );

    // THEN no settled write kept its slot
    await expect(read.map((reads) => reads.map(({ size }) => size))).toBeOkWith([MiB, MiB]);
  });

  it("sends every part of a streamed write through the pool", async ({ agents, s3, keyPrefix }) => {
    // GIVEN a source of four 8 MiB parts, each over the 2 MiB from which the
    // SDK sends `Expect: 100-continue`
    // WHEN it is written
    const written = await s3.putStream(`${keyPrefix}parts.bin`, aStream(32 * MiB), {
      contentType: "application/octet-stream",
    });

    // THEN every connection came from the pool's agent, rather than each part
    // opening one through an agent of its own that no pool bounds
    expect({ written: written.isOk(), agents: agents() }).toEqual({ written: true, agents: 1 });
  });

  it("closes a stalled store's socket after the socket timeout alone", async ({ stalled }) => {
    // GIVEN a store that never answers, and only the socket timeout set
    // WHEN an object is headed
    const head = stalled.head("a.bin");

    // THEN the idle socket was closed, rather than the call hanging
    await expect(head).toBeErrWith(
      expect.objectContaining({ operation: "head", reason: expect.stringContaining("inactivity") }),
    );
  });

  it("closes a stalled stream after the shared socket timeout when the stream pool sets none", async ({
    stalled,
  }) => {
    // GIVEN a store that never answers, and only the shared socket timeout set
    // WHEN an object is streamed
    const stream = stalled.getStream("a.bin");

    // THEN the stream pool took the shared bound
    await expect(stream).toBeErrWith(
      expect.objectContaining({
        operation: "getStream",
        reason: expect.stringContaining("after 200 ms of inactivity"),
      }),
    );
  });

  it("closes a stalled short call after its timeout while a stream waits under the longer one", async ({
    stalledStreams,
  }) => {
    // GIVEN a store that never answers, 200 ms for the short calls and 1000 ms
    // for the stream pool
    // WHEN an object is streamed and another headed, the stream looked at
    // the moment the head is answered
    const stream = stalledStreams.getStream("a.bin");
    const headed = await stalledStreams.head("b.bin");
    const streamWhenHeaded = await Promise.race([
      stream.then(() => "answered"),
      setTimeout(0, "open"),
    ]);
    const streamed = await stream;

    // THEN the short call was closed after its own 200 ms while the stream
    // was still open, and the stream after the stream pool's 1000 ms
    expect({
      head: headed.isErr() ? headed.error : headed.tag,
      streamWhenHeaded,
      stream: streamed.isErr() ? streamed.error : streamed.tag,
    }).toEqual({
      head: expect.objectContaining({
        operation: "head",
        reason: expect.stringContaining("after 200 ms of inactivity"),
      }),
      streamWhenHeaded: "open",
      stream: expect.objectContaining({
        operation: "getStream",
        reason: expect.stringContaining("after 1000 ms of inactivity"),
      }),
    });
  });

  it("gives streamed writes the stream pool's own request timeout", async ({
    hurried,
    keyPrefix,
  }) => {
    // GIVEN 1 ms for a short call to be answered, and a minute for a stream's
    // WHEN 8 MiB are streamed
    const written = hurried.putStream(`${keyPrefix}slow.bin`, aStream(8 * MiB), {
      contentType: "application/octet-stream",
    });

    // THEN the stream pool's bound held, not the short calls'
    await expect(written).toBeOk();
  });

  it("fails a call past its request timeout, rather than only warning", async ({
    hurried,
    keyPrefix,
  }) => {
    // GIVEN a store whose calls must be answered within 1 ms
    // WHEN 8 MiB are written
    const written = hurried.put(`${keyPrefix}slow.bin`, new Uint8Array(8 * MiB), {
      contentType: "application/octet-stream",
    });

    // THEN the bound is the SDK's error, not its log line
    await expect(written).toBeErrWith(
      expect.objectContaining({
        operation: "put",
        reason: expect.stringContaining("requestTimeout"),
      }),
    );
  });
});
