import { describe, expect } from "vitest";

import {
  aDocument,
  aStream,
  defectiveStorage,
  failingStorage,
  it,
} from "./__tests__/test-fixtures.js";
import { memoryStorage } from "./memory.js";

describe("storage, observed", () => {
  it("opens one span per operation, named for it and carrying the key", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented store over the memory adapter
    const document = aDocument();

    // WHEN an object is written and read back
    await instrumented.run(memoryStorage(), (service) =>
      service
        .put("a/b.json", document.bytes, { contentType: document.contentType })
        .flatMap(() => service.get("a/b.json")),
    );

    // THEN each operation has its own span, named for it and keyed
    expect(
      instrumented
        .spans()
        .map((span) => ({ name: span.name, key: span.attributes["btravstack.storage.key"] })),
    ).toEqual([
      { name: "storage.put", key: "a/b.json" },
      { name: "storage.get", key: "a/b.json" },
    ]);
  });

  it("counts each operation by name and outcome", async ({ instrumented }) => {
    // GIVEN an instrumented store
    const document = aDocument();

    // WHEN an object is written, read and deleted
    await instrumented.run(memoryStorage(), (service) =>
      service
        .put("a/b.json", document.bytes, { contentType: document.contentType })
        .flatTap(() => service.get("a/b.json"))
        .flatMap(() => service.delete("a/b.json")),
    );

    // THEN three points, one per operation, all ok
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([
      { operation: "put", result: "ok", outcome: "ok", value: 1 },
      { operation: "get", result: "ok", outcome: "ok", value: 1 },
      { operation: "delete", result: "ok", outcome: "ok", value: 1 },
    ]);
  });

  it("counts a missing object as not_found, and does not log it as a fault", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented store with nothing in it
    // WHEN an absent key is read
    await instrumented.run(memoryStorage(), (service) => service.get("absent"));

    // THEN it is counted apart from a failure and logged at info: asking for
    // something that is not there is an ordinary answer, and a dashboard
    // that pages on it teaches its readers to ignore the fault line
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      lines: instrumented.lines().map((line) => ({ level: line.level, message: line.message })),
    }).toEqual({
      points: [
        {
          operation: "get",
          result: "not_found",
          reason: "the object was not there",
          outcome: "ok",
          value: 1,
        },
      ],
      lines: [],
    });
  });

  it("counts and logs a store that could not answer", async ({ instrumented }) => {
    // GIVEN an instrumented store whose adapter is down
    // WHEN an object is read
    await instrumented.run(failingStorage(), (service) => service.get("a/b.json"));

    // THEN this one IS a fault: an error line and an error count
    expect({
      lines: instrumented.lines().map((line) => ({ level: line.level, message: line.message })),
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    }).toEqual({
      lines: [{ level: "error", message: "storage.get failed" }],
      points: [{ operation: "get", result: "error", outcome: "error", value: 1 }],
    });
  });

  it("hands the caller's own Result straight back", async ({ instrumented }) => {
    // GIVEN an instrumented store whose adapter is down
    // WHEN an object is written
    const written = await instrumented.run(failingStorage(), (service) =>
      service.put("a/b.json", new Uint8Array([1]), { contentType: "application/json" }),
    );

    // THEN the wrapper is transparent: the backend's error is what arrives
    expect(written).toBeErrWith(
      expect.objectContaining({ operation: "put", key: "a/b.json", reason: "no route" }),
    );
  });

  it("counts a presign refusal as not_found, and says what it actually was", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented store over an adapter that cannot presign, and an
    // object that IS there
    await instrumented.run(memoryStorage(), (service) =>
      service
        .put("a/b.json", new Uint8Array([1]), { contentType: "application/json" })
        .flatMap(() => service.presignedUrl("a/b.json", { ttlMs: 60_000 })),
    );

    // THEN it shares the RESULT of a missing object — a "no" the caller can act
    // on, not an outage — but NOT its reason: the object is sitting right where
    // it was put, and an operator sent hunting for it would be hunting nothing
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      lines: instrumented.lines().map((line) => line.message),
    }).toEqual({
      points: [
        { operation: "put", result: "ok", outcome: "ok", value: 1 },
        {
          operation: "presigned_url",
          result: "not_found",
          reason: "this store cannot mint a url",
          outcome: "ok",
          value: 1,
        },
      ],
      lines: [],
    });
  });

  it("counts an upload presign under its own operation", async ({ instrumented }) => {
    // GIVEN an instrumented store over an adapter that cannot presign
    await instrumented.run(memoryStorage(), (service) =>
      service.presignedUpload("a/b.json", {
        ttlMs: 60_000,
        contentType: "application/json",
        contentLength: 11,
      }),
    );

    // THEN a write url is a different operation from a read one, so a
    // dashboard can tell the two flows apart
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      spans: instrumented.spans().map((span) => span.name),
    }).toEqual({
      points: [
        {
          operation: "presigned_upload",
          result: "not_found",
          reason: "this store cannot mint a url",
          outcome: "ok",
          value: 1,
        },
      ],
      spans: ["storage.presigned_upload"],
    });
  });
  it("counts the streamed operations under their own names", async ({ instrumented }) => {
    // GIVEN an instrumented store
    // WHEN a stream is written, written again conditionally, and read
    await instrumented.run(memoryStorage(), (service) =>
      service
        .putStream("a.bin", aStream(1), { contentType: "t" })
        .flatMap(() => service.putStreamIfAbsent("b.bin", aStream(1), { contentType: "t" }))
        .flatMap(() => service.getStream("a.bin")),
    );

    // THEN each is its own operation, so a dashboard tells them from whole-object ones
    expect({
      points: instrumented.points().map((point) => point.attributes["operation"]),
      spans: instrumented.spans().map((span) => span.name),
    }).toEqual({
      points: ["put_stream", "put_stream_if_absent", "get_stream"],
      spans: ["storage.put_stream", "storage.put_stream_if_absent", "storage.get_stream"],
    });
  });

  it("counts a failed source as interrupted, and does not log it as a fault", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented store
    // WHEN a stream that breaks partway is written
    await instrumented.run(memoryStorage(), (service) =>
      service.putStream("a.bin", aStream(131_072, { failingAt: 65_536 }), { contentType: "t" }),
    );

    // THEN the caller's own stream failing is an ordinary answer, not an outage
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      faults: instrumented.lines().filter((line) => line.level === "error"),
    }).toEqual({
      points: [
        {
          operation: "put_stream",
          result: "interrupted",
          reason: "the source stream failed",
          outcome: "ok",
          value: 1,
        },
      ],
      faults: [],
    });
  });
});

describe("storage, instrumented, when the client defects", () => {
  it("still ends the span and counts the operation as an error", async ({ instrumented }) => {
    // GIVEN an instrumented store over a client that throws
    // WHEN an object is read
    await instrumented.run(defectiveStorage(), (service) => service.get("a/b.json"));

    // THEN the call is counted an error, and the span it opened was ended
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      spans: instrumented.spans().map((span) => span.name),
    }).toEqual({
      points: [{ operation: "get", result: "error", outcome: "error", value: 1 }],
      spans: ["storage.get"],
    });
  });

  it("counts an existing object as exists, and does not log it as a fault", async ({
    instrumented,
  }) => {
    // GIVEN an instrumented store already holding the key
    // WHEN a conditional put meets it
    await instrumented.run(memoryStorage(), (service) =>
      service
        .put("a/b.json", new Uint8Array([1]), { contentType: "application/json" })
        .flatMap(() =>
          service.putIfAbsent("a/b.json", new Uint8Array([2]), { contentType: "application/json" }),
        ),
    );

    // THEN losing the race is an ordinary answer: ok, counted apart as exists
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([
      { operation: "put", result: "ok", outcome: "ok", value: 1 },
      {
        operation: "put_if_absent",
        result: "exists",
        reason: "an object already held the key",
        outcome: "ok",
        value: 1,
      },
    ]);
  });

  it("counts a copy and a head of a missing key as ok with not_found", async ({ instrumented }) => {
    // GIVEN an instrumented in-memory store with nothing in it
    // WHEN a missing key is copied and headed
    await instrumented.run(memoryStorage(), async (service) => {
      await service.copy("a", "b", { contentType: "application/json" });
      await service.head("a");
    });

    // THEN both settle ok, counted apart as not_found
    expect(
      instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
    ).toEqual([
      {
        operation: "copy",
        result: "not_found",
        reason: "the object was not there",
        outcome: "ok",
        value: 1,
      },
      {
        operation: "head",
        result: "not_found",
        reason: "the object was not there",
        outcome: "ok",
        value: 1,
      },
    ]);
  });
});

describe("storage options observation", () => {
  it("keeps metadata out of routine observations", async ({ instrumented }) => {
    // GIVEN an instrumented memory store
    // WHEN confidential metadata is written and headed
    await instrumented.run(memoryStorage(), (service) =>
      service
        .put("key", aDocument().bytes, {
          contentType: "application/json",
          metadata: { confidential: "private-description" },
        })
        .flatMap(() => service.head("key")),
    );
    // THEN observation carries only the operation and object key
    expect({
      spans: instrumented.spans().map((span) => span.attributes),
      lines: instrumented.lines(),
      points: instrumented.points().map((point) => point.attributes),
    }).toEqual({
      spans: [
        {
          operation: "put",
          "btravstack.storage.key": "key",
        },
        {
          operation: "head",
          "btravstack.storage.key": "key",
        },
      ],
      lines: [],
      points: [
        { operation: "put", result: "ok", outcome: "ok" },
        { operation: "head", result: "ok", outcome: "ok" },
      ],
    });
  });

  it.for(["invalid", "0".repeat(64)])(
    "reports checksum refusal %s as an error without input details",
    async (sha256, { instrumented }) => {
      // GIVEN a digest the store will refuse
      // WHEN the write fails input validation or body verification
      await instrumented.run(memoryStorage(), (service) =>
        service.put("key", aDocument().bytes, {
          contentType: "application/json",
          sha256,
          metadata: { confidential: "private-description" },
        }),
      );
      // THEN failure is counted and the line does not contain the digest or metadata
      expect({
        points: instrumented.points().map((point) => point.attributes),
        lines: instrumented.lines().map((line) => ({ level: line.level, message: line.message })),
        inputLeaked: JSON.stringify({
          spans: instrumented.spans().map((span) => span.attributes),
          lines: instrumented.lines(),
        }).includes("private-description"),
      }).toEqual({
        points: [{ operation: "put", result: "error", outcome: "error" }],
        lines: [{ level: "error", message: "storage.put failed" }],
        inputLeaked: false,
      });
    },
  );
});
