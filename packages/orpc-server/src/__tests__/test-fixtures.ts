import { request, type IncomingMessage } from "node:http";

import { Observers, type Operation } from "@btravstack/core";
import { Provider } from "@btravstack/di";
import { it as base, type HttpFixtures } from "@btravstack/internal-http-fixtures";
import { oc } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { RequestCompressionHandlerPlugin } from "@orpc/server/plugins";
import { OkAsync, fromSafePromise } from "unthrown";
import { vi, type TestAPI } from "vitest";
import { z } from "zod";

import { defineHttp } from "../define-http.js";
import { HttpModule } from "../http-module.js";

/** The stream limit the `pinned` app sets, and the specs hand `HTTP_STREAM_BODY_LIMIT`. */
export const STREAM_LIMIT = 65_536;

/** What the content route's `GET` streams back. */
export const DOWNLOAD = "a".repeat(4096);

/**
 * One app over the content contract: `buffered` has a 1 KiB `bodyLimit`, request
 * decompression and the default stream limit; `compressed` adds response
 * compression; `pinned` pins `streamBodyLimit` to {@link STREAM_LIMIT};
 * `unbounded` pins it `false`.
 */
export type BodiesApp = "buffered" | "compressed" | "pinned" | "unbounded";

export type Answer = {
  readonly status: number;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
};

export type Bodies = {
  /** Boots one app on an ephemeral port, over `env`, and answers its port. */
  readonly serve: (app: BodiesApp, env?: Readonly<Record<string, string>>) => Promise<number>;
  /** Settles once the content route's `PUT` has read its first chunk. */
  readonly firstChunk: Promise<void>;
  /** The defects the served apps reported in this test. */
  readonly defects: readonly Operation[];
  /** A raw `PUT`, its body written by the test, its answer read whole. */
  readonly put: (
    port: number,
    path: string,
    headers: Readonly<Record<string, string>>,
  ) => { readonly request: ReturnType<typeof request>; readonly answer: Promise<Answer> };
  /** A raw `GET` with no `accept-encoding`, read whole. */
  readonly get: (port: number, path: string) => Promise<Answer>;
};

type Fixtures = { portWarnings: () => readonly unknown[]; bodies: Bodies };

export const it: TestAPI<HttpFixtures & Fixtures> = base.extend<Fixtures>({
  // oxlint-disable-next-line no-empty-pattern -- this fixture observes diagnostics without changing console behavior
  portWarnings: async ({}, use) => {
    const warnings = vi.spyOn(console, "warn");
    await use(() => warnings.mock.calls);
    warnings.mockRestore();
  },
  bodies: async ({ boot }, use) => {
    let sawFirstChunk = (): void => {};
    const firstChunk = new Promise<void>((resolve) => (sawFirstChunk = resolve));
    const defects: Operation[] = [];
    const observer = Provider.member(Observers)({
      inject: {},
      sync: () => (operation) => () => {
        if (operation.name === "defect") defects.push(operation);
      },
    });
    const shared = {
      router: contentRouterOf(() => sawFirstChunk()),
      provides: [observer],
      port: 0,
      hostname: "127.0.0.1",
    } as const;
    const decompressing = { plugins: [new RequestCompressionHandlerPlugin()] };
    const apps = {
      buffered: () =>
        HttpModule("BufferedBodies")({ ...shared, bodyLimit: 1024, openapi: decompressing }),
      compressed: () =>
        HttpModule("CompressedBodies")({
          ...shared,
          bodyLimit: 1024,
          compression: true,
          openapi: decompressing,
        }),
      pinned: () =>
        HttpModule("PinnedStreamLimit")({
          ...shared,
          bodyLimit: 1024,
          streamBodyLimit: STREAM_LIMIT,
          openapi: true,
        }),
      unbounded: () =>
        HttpModule("UnboundedStreams")({ ...shared, streamBodyLimit: false, openapi: true }),
    };
    await use({
      serve: async (app, env = {}) =>
        (await boot(apps[app](), { env }).runtimeInfo()).get()?.port ?? 0,
      firstChunk,
      defects,
      put,
      get,
    });
  },
});

const contentContract = {
  content: {
    put: oc
      .meta(
        openapi({
          method: "PUT",
          path: "/content/{key}",
          inputStructure: "detailed",
          requestBodyHint: "octet-stream",
        }),
      )
      .input(
        z.object({ params: z.object({ key: z.string() }), body: z.instanceof(ReadableStream) }),
      )
      .output(z.object({ key: z.string(), bytes: z.number() })),
    get: oc
      .meta(openapi({ method: "GET", path: "/content/{key}", outputStructure: "detailed" }))
      .input(z.object({ key: z.string() }))
      .output(
        z.object({ headers: z.record(z.string(), z.string()), body: z.instanceof(ReadableStream) }),
      ),
  },
  items: {
    create: oc
      .meta(openapi({ method: "POST", path: "/items" }))
      .input(z.object({ name: z.string() }))
      .output(z.object({ name: z.string() })),
  },
};

/**
 * The `PUT` counts the bytes it reads, calling `sawFirstChunk` on the first; the
 * `GET` streams {@link DOWNLOAD} with its own headers, or errors midway for `broken`.
 */
const contentRouterOf = (sawFirstChunk: () => void) =>
  defineHttp().OrpcRouter(contentContract)({
    inject: {},
    sync: () => ({
      content: {
        put: (_context, { params, body }) =>
          fromSafePromise(countBytes(body as ReadableStream<Uint8Array>, sawFirstChunk)).map(
            (bytes) => ({ key: params.key, bytes }),
          ),
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

const countBytes = async (
  body: ReadableStream<Uint8Array>,
  sawFirstChunk: () => void,
): Promise<number> => {
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

const put: Bodies["put"] = (port, path, headers) => {
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

const get: Bodies["get"] = (port, path) =>
  new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (response) =>
      answerOf(response).then(resolve, reject),
    )
      .on("error", reject)
      .end();
  });
