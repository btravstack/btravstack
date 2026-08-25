import { describe, expect } from "vitest";

import { aDocument, defectiveStorage, failingStorage, it } from "./__tests__/test-fixtures.js";
import { memoryStorage } from "./memory.js";

describe("storage, instrumented", () => {
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
      { operation: "put", outcome: "ok", value: 1 },
      { operation: "get", outcome: "ok", value: 1 },
      { operation: "delete", outcome: "ok", value: 1 },
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
      points: [{ operation: "get", outcome: "not_found", value: 1 }],
      lines: [{ level: "info", message: "the object was not there" }],
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
      lines: [{ level: "error", message: "the store could not answer" }],
      points: [{ operation: "get", outcome: "error", value: 1 }],
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

    // THEN it shares the outcome of a missing object — a "no" the caller can
    // act on, not an outage — but NOT its message: the object is sitting
    // right where it was put, and an operator sent hunting for it would be
    // hunting nothing
    expect({
      points: instrumented.points().map((point) => ({ ...point.attributes, value: point.value })),
      lines: instrumented.lines().map((line) => line.message),
    }).toEqual({
      points: [
        { operation: "put", outcome: "ok", value: 1 },
        { operation: "presigned_url", outcome: "not_found", value: 1 },
      ],
      lines: ["this store cannot mint a url"],
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
      points: [{ operation: "get", outcome: "error", value: 1 }],
      spans: ["storage.get"],
    });
  });
});
