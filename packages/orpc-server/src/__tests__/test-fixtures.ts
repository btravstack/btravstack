import { request, type IncomingMessage } from "node:http";

import { authenticated } from "@btravstack/contract";
import { Observers, type Operation, type Settled } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { CredentialRefused, HttpAuthenticator, Unauthenticated } from "@btravstack/http-server";
import { it as base, type HttpFixtures } from "@btravstack/internal-http-fixtures";
import { oc, type Schema } from "@orpc/contract";
import { openapi } from "@orpc/openapi";
import { RequestCompressionHandlerPlugin } from "@orpc/server/plugins";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
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
  /** What became of each stream the content route's `GET` opened, in order. */
  readonly downloads: readonly ("opened" | "cancelled")[];
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
  /** Calls a procedure over `/rpc` with `input`, as the RPC link would, and answers its status. */
  readonly rpc: (port: number, procedure: string, input: unknown) => Promise<number>;
};

/** The grant a capability URL carries, which its scheme accepts for file `42`. */
export const GRANT = "payload.signature";

/** A grant the scheme refuses: present, so `403` rather than `401`. */
export const FORGED = "payload.forged";

export type Capability = {
  /** Boots the capability app on an ephemeral port and answers its origin. */
  readonly serve: () => Promise<string>;
  /** What happened, in order: the handler, the client, the stream, the unit's close. */
  readonly log: string[];
  /** Lets the download stream its second chunk. */
  readonly release: () => void;
  /** Every operation the app reported, as started and as settled. */
  readonly observed: readonly (Operation | Settled)[];
};

type Fixtures = { portWarnings: () => readonly unknown[]; bodies: Bodies; capability: Capability };

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
    const downloads: ("opened" | "cancelled")[] = [];
    const observer = Provider.member(Observers)({
      inject: {},
      sync: () => (operation) => () => {
        if (operation.name === "defect") defects.push(operation);
      },
    });
    const shared = {
      router: contentRouterOf(() => sawFirstChunk(), downloads),
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
      downloads,
      defects,
      put,
      get,
      rpc,
    });
  },
  capability: async ({ boot }, use) => {
    const log: string[] = [];
    const observed: (Operation | Settled)[] = [];
    let release = (): void => {};
    const released = new Promise<void>((resolve) => (release = resolve));
    const observer = Provider.member(Observers)({
      inject: {},
      sync: () => (operation) => {
        observed.push(operation);
        return (settled) => void observed.push(settled);
      },
    });
    const app = HttpModule("CapabilityUrls")({
      router: capabilityRouterOf(log, released),
      provides: [observer],
      unit: { grant: grantUnitOf(log) },
      port: 0,
      hostname: "127.0.0.1",
      openapi: true,
    });
    await use({
      serve: async () => `http://127.0.0.1:${(await boot(app).runtimeInfo()).get()?.port ?? 0}`,
      log,
      release,
      observed,
    });
  },
});

/** A vendor-neutral output schema that validates asynchronously and rejects on anything but an item. */
const asyncItem: Schema<{ name: string }> = {
  "~standard": {
    version: 1,
    vendor: "fixture",
    validate: (value) =>
      Promise.resolve().then(() => ({ value: { name: (value as { name: string }).name.trim() } })),
  },
};

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
    export: oc
      .meta(
        openapi({
          method: "GET",
          path: "/exports/{key}",
          outputStructure: "detailed",
          responseBodyHint: "octet-stream",
        }),
      )
      .input(z.object({ key: z.string() }))
      .output(z.object({ body: z.custom<ReadableStream>() })),
  },
  items: {
    create: oc
      .meta(openapi({ method: "POST", path: "/items" }))
      .input(z.object({ name: z.string() }))
      .output(z.object({ name: z.string() })),
    checked: oc.input(z.object({ name: z.string() })).output(asyncItem),
    counted: oc
      .meta(openapi({ method: "GET", path: "/items/count", outputStructure: "detailed" }))
      .output(z.object({ body: z.object({ count: z.number().optional() }) })),
    sized: oc
      .meta(openapi({ method: "GET", path: "/items/size", outputStructure: "detailed" }))
      .output(z.object({ body: z.unknown() }).refine(({ body }) => body instanceof ReadableStream)),
  },
};

/**
 * The `PUT` counts the bytes it reads, calling `sawFirstChunk` on the first; the
 * `GET` streams {@link DOWNLOAD} with its own headers, recording into `downloads`
 * the stream it opened and its cancellation, or errors midway for `broken`.
 */
const contentRouterOf = (sawFirstChunk: () => void, downloads: ("opened" | "cancelled")[]) =>
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
                  body: recorded(DOWNLOAD, downloads),
                },
          ),
        export: () => OkAsync({ body: recorded(DOWNLOAD, downloads) }),
      },
      items: {
        create: (_context, input) => OkAsync(input),
        checked: (_context, input) => OkAsync(input),
        counted: () => OkAsync({ body: { count: 1 } }),
        sized: () => OkAsync({ body: recorded(DOWNLOAD, downloads) }),
      },
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

const recorded = (
  text: string,
  downloads: ("opened" | "cancelled")[],
): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: () => void downloads.push("opened"),
    pull: (controller) => {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
    cancel: () => void downloads.push("cancelled"),
  });

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

const grantAuth = HttpAuthenticator<{ readonly fileId: string }>()({
  inject: {},
  sync: () => (_headers, query) => {
    const grant = query.get("grant");
    if (grant === null) return ErrAsync(new Unauthenticated());
    return grant === GRANT ? OkAsync({ fileId: "42" }) : ErrAsync(new CredentialRefused());
  },
});

const capabilityAuth = defineHttp({ authenticators: { grant: grantAuth } });

class Download extends Port("CapabilityDownload")<{
  readonly fileId: string;
  readonly open: () => boolean;
}> {}

/** The `grant` kind's unit: the file its principal names, and whether the unit is still open. */
const grantUnitOf = (log: string[]) => {
  let open = true;
  return Module("GrantUnit")({
    provides: [
      Provider(Download)({
        inject: { grantee: capabilityAuth.principals.grant },
        sync: ({ grantee }) => ({ fileId: grantee.fileId, open: () => open }),
        onStop: () => {
          open = false;
          log.push("unit closed");
        },
      }),
    ],
    exports: [Download],
  });
};

const capabilityApi = capabilityAuth.units<{ grant: ReturnType<typeof grantUnitOf> }>();

/** A file behind a capability URL: `GET /files/{id}?grant=…`, streamed. */
export const capabilityContract = {
  files: authenticated({ grant: [] })({
    download: oc
      .meta(openapi({ method: "GET", path: "/files/{id}", outputStructure: "detailed" }))
      .input(z.object({ id: z.string() }))
      .output(
        z.object({ headers: z.record(z.string(), z.string()), body: z.instanceof(ReadableStream) }),
      ),
  }),
};

/**
 * The download answers at once with a stream whose second chunk waits for
 * `released`, then reports whether the unit it reads from was still open.
 */
const capabilityRouterOf = (log: string[], released: Promise<void>) =>
  capabilityApi.OrpcRouter(capabilityContract)({
    inject: {},
    unit: { download: Download },
    sync: () => ({
      files: {
        download: ({ context }) => {
          const { download } = context.unit;
          let pulls = 0;
          const body = new ReadableStream<Uint8Array>(
            {
              pull: async (controller) => {
                pulls += 1;
                if (pulls > 1) {
                  await released;
                  log.push(
                    download.open() ? "streamed in an open unit" : "streamed in a closed unit",
                  );
                  controller.enqueue(new TextEncoder().encode(";last"));
                  controller.close();
                  return;
                }
                controller.enqueue(new TextEncoder().encode(download.fileId));
              },
            },
            { highWaterMark: 0 },
          );
          log.push("handler answered");
          return OkAsync({ headers: { "content-type": "text/plain" }, body });
        },
      },
    }),
  });

const rpc: Bodies["rpc"] = async (port, procedure, input) =>
  (
    await fetch(`http://127.0.0.1:${port}/rpc/${procedure}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: input }),
    })
  ).status;
