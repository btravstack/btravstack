import { gzipSync } from "node:zlib";

import { describe, expect } from "vitest";

import { DOWNLOAD, STREAM_LIMIT, it } from "./__tests__/test-fixtures.js";

describe("body limits by kind", () => {
  it("hands a route that reads a stream its body while the client is still sending", async ({
    bodies,
  }) => {
    // GIVEN a PUT route reading its body as a stream, under a 1 KiB buffered limit
    const port = await bodies.serve("buffered");

    // WHEN a client sends 2 KiB, waits for the handler to see bytes, then sends 8 KiB more
    const sending = bodies.put(port, "/api/content/report", {});
    sending.request.write(Buffer.alloc(2048, 1));
    await bodies.firstChunk;
    sending.request.end(Buffer.alloc(8192, 1));
    const answer = await sending.answer;

    // THEN the handler read the whole body, over the buffered limit, as it arrived
    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      { key: "report", bytes: 10_240 },
    ]);
  });

  it("refuses a chunked stream once it passes the stream limit", async ({ bodies }) => {
    // GIVEN a stream limit read from the environment
    const port = await bodies.serve("buffered", { HTTP_STREAM_BODY_LIMIT: String(STREAM_LIMIT) });

    // WHEN a client sends more than the limit, declaring no length
    const sending = bodies.put(port, "/api/content/report", { "transfer-encoding": "chunked" });
    sending.request.end(Buffer.alloc(STREAM_LIMIT + 1, 1));
    const answer = await sending.answer;

    // THEN the stream errored past the limit, the route answered 413, and the
    // handler's unmodeled failure was not reported as a defect
    expect({ status: answer.status, defects: bodies.defects }).toEqual({
      status: 413,
      defects: [],
    });
  });

  it("refuses a declared length over the stream limit before reading", async ({ bodies }) => {
    // GIVEN a stream limit pinned by the option
    const port = await bodies.serve("pinned");

    // WHEN a client declares a length over the limit and sends nothing yet
    const sending = bodies.put(port, "/api/content/report", {
      "content-length": String(STREAM_LIMIT + 1),
    });
    sending.request.flushHeaders();
    const answer = await sending.answer;
    sending.request.destroy();

    // THEN the route answered 413 on the header alone
    expect(answer.status).toBe(413);
  });

  it("takes `streamBodyLimit: false` as unbounded, over the environment", async ({ bodies }) => {
    // GIVEN the stream limit pinned off against a deployment saying 16 bytes
    const port = await bodies.serve("unbounded", { HTTP_STREAM_BODY_LIMIT: "16" });

    // WHEN a client streams 128 KiB
    const sending = bodies.put(port, "/api/content/report", { "transfer-encoding": "chunked" });
    sending.request.end(Buffer.alloc(131_072, 1));
    const answer = await sending.answer;

    // THEN the pin won and the whole body was read
    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      { key: "report", bytes: 131_072 },
    ]);
  });

  it("keeps the buffered limit on a JSON body", async ({ bodies }) => {
    // GIVEN a 1 KiB buffered limit beside a 1 GiB stream limit
    const port = await bodies.serve("buffered");

    // WHEN a JSON body over the buffered limit is sent
    const response = await fetch(`http://127.0.0.1:${port}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(2048) }),
    });

    // THEN it is refused
    expect(response.status).toBe(413);
  });

  it("measures a compressed body once decompressed", async ({ bodies }) => {
    // GIVEN request decompression beside a 1 KiB buffered limit
    const port = await bodies.serve("buffered");

    // WHEN a gzip body far under the limit on the wire, and over it inflated, is sent
    const response = await fetch(`http://127.0.0.1:${port}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(JSON.stringify({ name: "x".repeat(4096) })),
    });

    // THEN the inflated size is what was refused
    expect(response.status).toBe(413);
  });

  it("streams a detailed answer with its own headers, uncompressed", async ({ bodies }) => {
    // GIVEN a GET route answering a ReadableStream with its own headers
    const port = await bodies.serve("buffered");

    // WHEN a client that accepts no encoding reads it
    const answer = await bodies.get(port, "/api/content/report");

    // THEN the headers and bytes arrive as the route wrote them
    expect({
      status: answer.status,
      type: answer.headers["content-type"],
      length: answer.headers["content-length"],
      disposition: answer.headers["content-disposition"],
      encoding: answer.headers["content-encoding"],
      body: answer.body,
    }).toEqual({
      status: 200,
      type: "text/plain",
      length: "4096",
      disposition: 'attachment; filename="report.txt"',
      encoding: undefined,
      body: DOWNLOAD,
    });
  });

  it("aborts the connection when the answer's stream errors midway", async ({ bodies }) => {
    // GIVEN a GET route whose stream errors after its first bytes
    const port = await bodies.serve("buffered");

    // WHEN a client reads the answer
    const response = await fetch(`http://127.0.0.1:${port}/api/content/broken`);

    // THEN the read rejects rather than ending cleanly on a short body
    await expect(response.text()).rejects.toThrow();
  });

  it("aborts a compressed answer when its stream errors midway", async ({ bodies }) => {
    // GIVEN response compression on, for a compressible stream that errors
    const port = await bodies.serve("compressed");

    // WHEN a client accepting gzip reads it to the end
    const response = await fetch(`http://127.0.0.1:${port}/api/content/broken`, {
      headers: { "accept-encoding": "gzip" },
    });
    const read = await response.text().then(
      () => "ended",
      () => "rejected",
    );

    // THEN the answer was compressed, and compression did not turn the error into a clean end
    expect({ encoding: response.headers.get("content-encoding"), read }).toEqual({
      encoding: "gzip",
      read: "rejected",
    });
  });
});
