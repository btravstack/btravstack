import { Readable } from "node:stream";

import { describe, expect } from "vitest";

import { aDocument, it } from "./__tests__/test-fixtures.js";
import { s3StorageBackend } from "./s3.js";

describe.each(["memory", "s3"] as const)("%s storage write options", (adapter) => {
  it("writes the verified digest and metadata atomically", async ({ memory, s3, keyPrefix }) => {
    // GIVEN bytes with their independently known SHA-256
    const store = adapter === "memory" ? memory : s3;
    const document = aDocument();
    // WHEN both object and description are published together
    const head = store
      .putIfAbsent(`${keyPrefix}verified`, document.bytes, {
        contentType: document.contentType,
        sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
        metadata: { producer: "compiler", revision: "r1" },
      })
      .flatMap(() => store.head(`${keyPrefix}verified`));
    // THEN head reports the verified object without reading its bytes
    await expect(head).toBeOkWith({
      size: 11,
      contentType: "application/json",
      sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
      metadata: { producer: "compiler", revision: "r1" },
    });
  });

  it.for(["put", "putIfAbsent"] as const)(
    "%s rejects a digest mismatch without publishing metadata",
    async (operation, { memory, s3, keyPrefix }) => {
      // GIVEN an absent key and a well-formed digest for other bytes
      const store = adapter === "memory" ? memory : s3;
      const key = `${keyPrefix}mismatch`;
      // WHEN the store verifies the write
      const written = await store[operation](key, aDocument().bytes, {
        contentType: "application/json",
        sha256: "0".repeat(64),
        metadata: { producer: "bad" },
      });
      const head = await store.head(key);
      // THEN neither the bytes nor their description exist
      expect({
        write: written.tag === "Err" ? written.error._tag : written.tag,
        head: head.tag === "Err" ? head.error._tag : head.tag,
      }).toEqual({ write: "ChecksumMismatch", head: "ObjectNotFound" });
    },
  );

  it("captures metadata when the write is called", async ({ memory, s3, keyPrefix }) => {
    // GIVEN caller-owned metadata that may change while credentials or I/O are pending
    const store = adapter === "memory" ? memory : s3;
    const metadata = { producer: "original" };
    // WHEN the caller changes its input immediately after invoking the write
    const written = store.put(`${keyPrefix}snapshot`, aDocument().bytes, {
      contentType: "application/json",
      metadata,
    });
    metadata.producer = "changed";
    // THEN the object describes the input at invocation, not a later mutation
    await expect(written.flatMap(() => store.head(`${keyPrefix}snapshot`))).toBeOkWith(
      expect.objectContaining({ metadata: { producer: "original" } }),
    );
  });

  it("preserves an existing object when an overwrite has a bad checksum", async ({
    memory,
    s3,
    keyPrefix,
  }) => {
    // GIVEN a successful object and description
    const store = adapter === "memory" ? memory : s3;
    const key = `${keyPrefix}preserved`;
    await store.put(key, aDocument().bytes, {
      contentType: "application/json",
      metadata: { producer: "first" },
    });
    // WHEN a replacement fails verification
    await store.put(key, new Uint8Array([0]), {
      contentType: "bad/type",
      sha256: "0".repeat(64),
      metadata: { producer: "bad" },
    });
    // THEN the successful object is untouched
    await expect(store.head(key)).toBeOkWith(
      expect.objectContaining({
        size: 11,
        contentType: "application/json",
        metadata: { producer: "first" },
      }),
    );
  });

  it("keeps the winning description and bytes on a conditional write", async ({
    memory,
    s3,
    keyPrefix,
  }) => {
    // GIVEN a successful first writer
    const store = adapter === "memory" ? memory : s3;
    const key = `${keyPrefix}winner`;
    await store.putIfAbsent(key, aDocument().bytes, {
      contentType: "application/json",
      metadata: { producer: "first" },
    });
    // WHEN a second writer tries to replace it
    const second = await store.putIfAbsent(key, new Uint8Array([0]), {
      contentType: "bad/type",
      metadata: { producer: "second" },
    });
    const head = (await store.head(key)).getOrThrow();
    // THEN first writer owns the whole object
    expect({ second: second.tag === "Err" ? second.error._tag : second.tag, head }).toEqual({
      second: "ObjectExists",
      head: expect.objectContaining({
        size: 11,
        contentType: "application/json",
        metadata: { producer: "first" },
      }),
    });
  });

  it.for(["bad", "A".repeat(64), "a".repeat(63), "g".repeat(64)])(
    "rejects malformed SHA-256 %s",
    async (sha256, { memory, s3, keyPrefix }) => {
      // GIVEN a digest outside the lowercase 64-hex contract
      const store = adapter === "memory" ? memory : s3;
      // WHEN a write supplies it
      const written = store.put(`${keyPrefix}invalid`, aDocument().bytes, {
        contentType: "application/json",
        sha256,
      });
      // THEN it is a modeled input refusal
      await expect(written).toBeErrWith(
        expect.objectContaining({ _tag: "InvalidStorageOptions", reason: "invalid_sha256" }),
      );
    },
  );

  it.for(["Producer", "", "a b", "é", "line\nbreak"])(
    "rejects metadata key %j without overwriting",
    async (name, { memory, s3, keyPrefix }) => {
      // GIVEN a successful object
      const store = adapter === "memory" ? memory : s3;
      const key = `${keyPrefix}invalid-meta`;
      await store.put(key, aDocument().bytes, { contentType: "application/json" });
      // WHEN metadata violates the lowercase ASCII token contract
      const written = await store.put(key, new Uint8Array([0]), {
        contentType: "bad/type",
        metadata: { [name]: "secret" },
      });
      const head = (await store.head(key)).getOrThrow();
      // THEN refusal leaves the body and metadata together
      expect({ written: written.tag === "Err" ? written.error._tag : written.tag, head }).toEqual({
        written: "InvalidStorageOptions",
        head: expect.objectContaining({ size: 11, contentType: "application/json", metadata: {} }),
      });
    },
  );

  it("replaces source metadata on copy and computes SHA-256 in the store", async ({
    memory,
    s3,
    keyPrefix,
  }) => {
    // GIVEN a source description belonging only to the source
    const store = adapter === "memory" ? memory : s3;
    const source = `${keyPrefix}source`;
    await store.put(source, aDocument().bytes, {
      contentType: "application/json",
      metadata: { producer: "source" },
    });
    // WHEN the copy supplies its own description and checksum algorithm
    const head = store
      .copy(source, `${keyPrefix}copy`, {
        contentType: "copy/type",
        checksum: "sha256",
        metadata: { producer: "destination" },
      })
      .flatMap(() => store.head(`${keyPrefix}copy`));
    // THEN bytes remain server side while destination metadata replaces the source's
    await expect(head).toBeOkWith({
      size: 11,
      contentType: "copy/type",
      sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
      metadata: { producer: "destination" },
    });
  });

  it("does not inherit source metadata when copy metadata is omitted", async ({
    memory,
    s3,
    keyPrefix,
  }) => {
    // GIVEN a described source
    const store = adapter === "memory" ? memory : s3;
    const source = `${keyPrefix}source`;
    await store.put(source, aDocument().bytes, {
      contentType: "application/json",
      metadata: { producer: "source" },
    });
    // WHEN no destination metadata is supplied
    const head = store
      .copy(source, `${keyPrefix}copy`, { contentType: "copy/type" })
      .flatMap(() => store.head(`${keyPrefix}copy`));
    // THEN the destination has no inherited description
    await expect(head).toBeOkWith(expect.objectContaining({ metadata: {} }));
  });
});

describe("storage snapshots and presigning", () => {
  it.for(["put", "putIfAbsent", "copy"] as const)(
    "owns metadata snapshots for %s",
    async (operation, { memory }) => {
      // GIVEN metadata retained by the caller
      const metadata = { producer: "original" };
      await memory.put("source", aDocument().bytes, { contentType: "application/json" });
      // WHEN input and returned metadata are mutated after a write
      if (operation === "copy") {
        await memory.copy("source", "snapshot", { contentType: "t", metadata });
      } else {
        await memory[operation]("snapshot", aDocument().bytes, { contentType: "t", metadata });
      }
      metadata.producer = "changed";
      const head = (await memory.head("snapshot")).getOrThrow();
      (head.metadata as Record<string, string>)["producer"] = "read-changed";
      // THEN neither caller owns the stored map
      await expect(memory.head("snapshot")).toBeOkWith(
        expect.objectContaining({ metadata: { producer: "original" } }),
      );
    },
  );

  it.for(["put", "putIfAbsent"] as const)(
    "owns verified Buffer bytes on %s",
    async (operation, { memory }) => {
      // GIVEN a Node Buffer, which is also a valid Uint8Array
      const bytes = Buffer.from(aDocument().bytes);
      await memory[operation]("buffer", bytes, {
        contentType: "application/json",
        sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
      });
      // WHEN the caller mutates its buffer after the verified write
      bytes.fill(0);
      // THEN the stored bytes remain those the digest verified
      await expect(memory.get("buffer")).toBeOkWith({
        bytes: aDocument().bytes,
        contentType: "application/json",
      });
    },
  );

  it("returns owned bytes after a verified Buffer write", async ({ memory }) => {
    // GIVEN a verified object supplied as a Node Buffer
    await memory.put("buffer", Buffer.from(aDocument().bytes), {
      contentType: "application/json",
      sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
    });
    // WHEN a reader overwrites its returned bytes
    (await memory.get("buffer")).getOrThrow().bytes.fill(0);
    // THEN stored bytes and checksum remain consistent
    await expect(memory.head("buffer")).toBeOkWith({
      size: 11,
      contentType: "application/json",
      metadata: {},
      sha256: "4062edaf750fb8074e7e83e0c9028c94e32468a8b6f1614774328ef045150f93",
    });
  });

  it("binds both KMS headers into the upload signature", async ({ sdkClient }) => {
    // GIVEN a real SDK client with credentials but no KMS store
    const store = s3StorageBackend(sdkClient, "bucket");
    // WHEN a per-object KMS key is presigned
    const url = (
      await store.presignedUpload("key", {
        ttlMs: 60_000,
        contentType: "t",
        contentLength: 1,
        kmsKeyId: "tenant-key",
      })
    ).getOrThrow();
    const parameters = new URL(url).searchParams;
    // THEN encryption is mandatory signed headers, never swappable query parameters
    expect({
      signed: parameters.get("X-Amz-SignedHeaders"),
      encryption: parameters.has("x-amz-server-side-encryption"),
      key: parameters.has("x-amz-server-side-encryption-aws-kms-key-id"),
    }).toEqual({
      signed:
        "content-length;content-type;host;x-amz-server-side-encryption;x-amz-server-side-encryption-aws-kms-key-id",
      encryption: false,
      key: false,
    });
  });

  it("refuses malformed upload digests before presigning", async ({ uncredentialed }) => {
    // GIVEN invalid options and a credential provider that would fail
    // WHEN the digest is not lowercase SHA-256
    const url = uncredentialed.presignedUpload("key", {
      ttlMs: 1_000,
      contentType: "t",
      contentLength: 1,
      sha256: "invalid",
    });
    // THEN input validation wins over credential resolution
    await expect(url).toBeErrTagged("InvalidStorageOptions");
  });
  it.for(["put", "putIfAbsent", "copy"] as const)(
    "refuses invalid metadata on %s before sending a command",
    async (operation, { unreachable }) => {
      // GIVEN invalid metadata and a store that would fail a request
      const options = { contentType: "t", metadata: { Name: "value", name: "collision" } };
      // WHEN options are validated at the adapter boundary
      const result =
        operation === "copy"
          ? unreachable.copy("source", "destination", options)
          : unreachable[operation]("destination", new Uint8Array(), options);
      // THEN no request was needed and no lowercase collision was overwritten
      await expect(result).toBeErrWith(
        expect.objectContaining({
          _tag: "InvalidStorageOptions",
          key: "destination",
          reason: "invalid_metadata_key",
        }),
      );
    },
  );

  it.for(["put", "putIfAbsent"] as const)(
    "maps S3 InvalidDigest on %s without exposing the digest",
    async (operation, { sdkClient }) => {
      // GIVEN a store refusing a digest with its alternate InvalidDigest code
      sdkClient.middlewareStack.add(
        () => async () =>
          Promise.reject(
            Object.assign(new Error("sensitive store message"), { name: "InvalidDigest" }),
          ),
        { step: "deserialize", name: "invalidDigest" },
      );
      const store = s3StorageBackend(sdkClient, "bucket");
      // WHEN the store refuses a well-formed write checksum
      const result = store[operation]("key", new Uint8Array(), {
        contentType: "t",
        sha256: "0".repeat(64),
      });
      // THEN callers get the explicit safe checksum refusal
      await expect(result).toBeErrWith(
        expect.objectContaining({
          _tag: "ChecksumMismatch",
          key: "key",
          message: expect.not.stringContaining("sensitive"),
        }),
      );
    },
  );

  it.for([undefined, "COMPOSITE", "unlabelled composite", "FULL_OBJECT"] as const)(
    "does not invent a full-object digest from %s checksums",
    async (checksumType, { sdkClient }) => {
      // GIVEN an external object with no checksum or only a multipart composite checksum
      sdkClient.middlewareStack.add(
        () => async () => ({
          output: {
            $metadata: {},
          },
          response: {
            statusCode: 200,
            headers:
              checksumType === undefined
                ? {}
                : {
                    "x-amz-checksum-sha256":
                      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" +
                      (checksumType === "FULL_OBJECT" ? "" : "-2"),
                    ...(checksumType === "unlabelled composite"
                      ? {}
                      : { "x-amz-checksum-type": checksumType }),
                  },
            body: Readable.from([]),
          },
        }),
        { step: "deserialize", name: "headExternal" },
      );
      const store = s3StorageBackend(sdkClient, "bucket");
      // WHEN metadata is read without reading bytes
      const head = await store.head("key");

      // THEN defaults remain honest and composite checksums stay excluded
      await expect(head).toBeOkWith({
        size: 0,
        contentType: "application/octet-stream",
        metadata: {},
        ...(checksumType === "FULL_OBJECT" ? { sha256: "0".repeat(64) } : {}),
      });
    },
  );

  it.for([
    { header: "x-amz-server-side-encryption", changed: undefined },
    { header: "x-amz-server-side-encryption", changed: "AES256" },
    { header: "x-amz-server-side-encryption-aws-kms-key-id", changed: undefined },
    { header: "x-amz-server-side-encryption-aws-kms-key-id", changed: "other-key" },
  ])(
    "refuses changed or omitted KMS header $header ($changed)",
    async ({ header, changed }, { s3, keyPrefix }) => {
      // GIVEN a URL bound to a tenant's KMS key (RustFS verifies signatures but has no KMS)
      const key = `${keyPrefix}kms`;
      const url = (
        await s3.presignedUpload(key, {
          ttlMs: 60_000,
          contentType: "application/octet-stream",
          contentLength: 1,
          kmsKeyId: "tenant-key",
        })
      ).getOrThrow();
      const headers: Record<string, string> = {
        "content-type": "application/octet-stream",
        "x-amz-server-side-encryption": "aws:kms",
        "x-amz-server-side-encryption-aws-kms-key-id": "tenant-key",
      };
      if (changed === undefined) delete headers[header];
      else headers[header] = changed;
      // WHEN the client violates the signed encryption requirements
      const response = await fetch(url, { method: "PUT", headers, body: new Uint8Array([1]) });
      const stored = await s3.head(key);
      // THEN the signature is refused before encryption and nothing is stored
      expect({
        status: response.status,
        stored: stored.tag === "Err" ? stored.error._tag : stored.tag,
      }).toEqual({ status: 403, stored: "ObjectNotFound" });
    },
  );
});
