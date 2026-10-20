import { request, type IncomingMessage } from "node:http";
import { gzipSync } from "node:zlib";

import type { RunningApp } from "@btravstack/core";
import type { HttpInfo } from "@btravstack/http-server";
import { it } from "@btravstack/internal-http-fixtures";
import { oc } from "@orpc/contract";
import { openapi as route } from "@orpc/openapi";
import { RequestCompressionHandlerPlugin } from "@orpc/server/plugins";
import { OkAsync, fromSafePromise } from "unthrown";
import { describe, expect } from "vitest";
import { z } from "zod";

import { defineHttp } from "./define-http.js";
import { HttpModule } from "./http-module.js";

const STREAM_LIMIT = 65_536;

const contract = {
  content: {
    put: oc
      .meta(
        route({
          method: "PUT",
          path: "/content/{key}",
          inputStructure: "detailed",
          requestBodyHint: "octet-stream",
        }),
      )
      .input(
        z.object({
          params: z.object({ key: z.string() }),
          body: z.instanceof(ReadableStream),
        }),
      )
      .output(z.object({ key: z.string(), bytes: z.number() })),
    get: oc
      .meta(route({ method: "GET", path: "/content/{key}", outputStructure: "detailed" }))
      .input(z.object({ key: z.string() }))
      .output(
        z.object({
          headers: z.record(z.string(), z.string()),
          body: z.instanceof(ReadableStream),
        }),
      ),
  },
  items: {
    create: oc
      .meta(route({ method: "POST", path: "/items" }))
      .input(z.object({ name: z.string() }))
      .output(z.object({ name: z.string() })),
  },
};

/** Called by the PUT handler once it has read its first chunk. */
let sawFirstChunk = (): void => {};

const DOWNLOAD = "a".repeat(4096);

const router = defineHttp().OrpcRouter(contract)({
  inject: {},
  sync: () => ({
    content: {
      put: (_context, { params, body }) =>
        fromSafePromise(countBytes(body as ReadableStream<Uint8Array>)).map((bytes) => ({
          key: params.key,
          bytes,
        })),
      get: (_context, { key }) =>
        OkAsync(
          key === "broken"
            ? { headers: { "content-type": "text/plain" }, body: brokenAfter(DOWNLOAD) }
            : {
                headers: {
                  "content-type": "text/plain",
                  "content-length": String(DOWNLOAD.length),
                  "content-disposition": 'attachment; filename="report.txt"',
                },
                body: new Blob([DOWNLOAD]).stream(),
              },
        ),
    },
    items: { create: (_context, input) => OkAsync(input) },
  }),
});

const appOf = (name: string, options: { readonly compression?: boolean } = {}) =>
  HttpModule(name)({
    router,
    port: 0,
    hostname: "127.0.0.1",
    bodyLimit: 1024,
    ...options,
    openapi: { plugins: [new RequestCompressionHandlerPlugin()] },
  });

const app = appOf("StreamedBodies");
const pinnedApp = HttpModule("PinnedStreamLimit")({
  router,
  port: 0,
  hostname: "127.0.0.1",
  bodyLimit: 1024,
  streamBodyLimit: STREAM_LIMIT,
  openapi: true,
});
const compressedApp = appOf("CompressedStreams", { compression: true });
const unboundedApp = HttpModule("UnboundedStreams")({
  router,
  port: 0,
  hostname: "127.0.0.1",
  streamBodyLimit: false,
  openapi: true,
});

describe("body limits by kind", () => {
  it("hands a route that reads a stream its body while the client is still sending", async ({
    boot,
  }) => {
    // GIVEN a PUT route reading its body as a stream, under a 1 KiB buffered limit
    const port = await portOf(boot(app));
    const firstChunk = new Promise<void>((resolve) => (sawFirstChunk = resolve));

    // WHEN a client sends 2 KiB, waits for the handler to see bytes, then sends 8 KiB more
    const sending = put(port, "/api/content/report", {});
    sending.request.write(Buffer.alloc(2048, 1));
    await firstChunk;
    sending.request.end(Buffer.alloc(8192, 1));
    const answer = await sending.answer;

    // THEN the handler read the whole body, over the buffered limit, as it arrived
    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      { key: "report", bytes: 10_240 },
    ]);
  });

  it("refuses a chunked stream once it passes the stream limit", async ({ boot }) => {
    // GIVEN a stream limit read from the environment
    const port = await portOf(boot(app, { env: { HTTP_STREAM_BODY_LIMIT: String(STREAM_LIMIT) } }));

    // WHEN a client sends more than the limit, declaring no length
    const sending = put(port, "/api/content/report", { "transfer-encoding": "chunked" });
    sending.request.end(Buffer.alloc(STREAM_LIMIT + 1, 1));

    // THEN the stream errored past the limit and the route answered 413
    expect((await sending.answer).status).toBe(413);
  });

  it("refuses a declared length over the stream limit before reading", async ({ boot }) => {
    // GIVEN a stream limit pinned by the option
    const port = await portOf(boot(pinnedApp));

    // WHEN a client declares a length over the limit and sends nothing yet
    const sending = put(port, "/api/content/report", {
      "content-length": String(STREAM_LIMIT + 1),
    });
    sending.request.flushHeaders();
    const answer = await sending.answer;
    sending.request.destroy();

    // THEN the route answered 413 on the header alone
    expect(answer.status).toBe(413);
  });

  it("takes `streamBodyLimit: false` as unbounded, over the environment", async ({ boot }) => {
    // GIVEN the stream limit pinned off against a deployment saying 16 bytes
    const port = await portOf(boot(unboundedApp, { env: { HTTP_STREAM_BODY_LIMIT: "16" } }));

    // WHEN a client streams 128 KiB
    const sending = put(port, "/api/content/report", { "transfer-encoding": "chunked" });
    sending.request.end(Buffer.alloc(131_072, 1));
    const answer = await sending.answer;

    // THEN the pin won and the whole body was read
    expect([answer.status, JSON.parse(answer.body)]).toEqual([
      200,
      { key: "report", bytes: 131_072 },
    ]);
  });

  it("keeps the buffered limit on a JSON body", async ({ boot }) => {
    // GIVEN a 1 KiB buffered limit beside a 1 GiB stream limit
    const port = await portOf(boot(app));

    // WHEN a JSON body over the buffered limit is sent
    const response = await fetch(`http://127.0.0.1:${port}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(2048) }),
    });

    // THEN it is refused
    expect(response.status).toBe(413);
  });

  it("measures a compressed body once decompressed", async ({ boot }) => {
    // GIVEN request decompression beside a 1 KiB buffered limit
    const port = await portOf(boot(app));

    // WHEN a gzip body far under the limit on the wire, and over it inflated, is sent
    const response = await fetch(`http://127.0.0.1:${port}/api/items`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: gzipSync(JSON.stringify({ name: "x".repeat(4096) })),
    });

    // THEN the inflated size is what was refused
    expect(response.status).toBe(413);
  });

  it("streams a detailed answer with its own headers, uncompressed", async ({ boot }) => {
    // GIVEN a GET route answering a ReadableStream with its own headers
    const port = await portOf(boot(app));

    // WHEN a client that accepts no encoding reads it
    const answer = await get(port, "/api/content/report");

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

  it("aborts the connection when the answer's stream errors midway", async ({ boot }) => {
    // GIVEN a GET route whose stream errors after its first bytes
    const port = await portOf(boot(app));

    // WHEN a client reads the answer
    const response = await fetch(`http://127.0.0.1:${port}/api/content/broken`);

    // THEN the read rejects rather than ending cleanly on a short body
    await expect(response.text()).rejects.toThrow();
  });

  it("aborts a compressed answer when its stream errors midway", async ({ boot }) => {
    // GIVEN response compression on, for a compressible stream that errors
    const port = await portOf(boot(compressedApp));

    // WHEN a client accepting gzip reads it
    const response = await fetch(`http://127.0.0.1:${port}/api/content/broken`, {
      headers: { "accept-encoding": "gzip" },
    });

    // THEN compression did not turn the error into a clean end
    expect(response.headers.get("content-encoding")).toBe("gzip");
    await expect(response.text()).rejects.toThrow();
  });
});

const portOf = async (running: RunningApp<unknown, HttpInfo>): Promise<number> =>
  (await running.runtimeInfo()).get()?.port ?? 0;

type Answer = {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
};

const answerOf = (response: IncomingMessage): Promise<Answer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("error", reject);
    response.on("end", () =>
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }),
    );
  });

const put = (port: number, path: string, headers: Record<string, string>) => {
  const outgoing = request({
    host: "127.0.0.1",
    port,
    path,
    method: "PUT",
    headers: { "content-type": "application/octet-stream", ...headers },
  });
  const answer = new Promise<Answer>((resolve, reject) => {
    outgoing.on("response", (response) => answerOf(response).then(resolve, reject));
    outgoing.on("error", reject);
  });
  return { request: outgoing, answer };
};

const get = (port: number, path: string): Promise<Answer> =>
  new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (response) =>
      answerOf(response).then(resolve, reject),
    )
      .on("error", reject)
      .end();
  });

const countBytes = async (body: ReadableStream<Uint8Array>): Promise<number> => {
  const reader = body.getReader();
  let bytes = 0;
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    if (bytes === 0) sawFirstChunk();
    bytes += read.value.byteLength;
  }
  return bytes;
};

const brokenAfter = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      setTimeout(() => controller.error(new Error("the store broke off")), 50);
    },
  });
