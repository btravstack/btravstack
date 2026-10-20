import { createHash, randomUUID } from "node:crypto";
import { Agent } from "node:http";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { S3Client } from "@aws-sdk/client-s3";
import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { observability, type Line } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { metrics, trace } from "@opentelemetry/api";
import { PeriodicExportingMetricReader, type DataPoint } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { inject, test } from "vitest";

import { memoryStorage } from "../memory.js";
import { storage } from "../module.js";
import { s3Storage, s3StorageBackend, type S3StorageOptions } from "../s3.js";
import { Storage, StorageBackend, StorageUnavailable, type StorageService } from "../storage.js";

/** An adapter whose store is down, so the failure arms are reachable without breaking the shared one. */
const failingBackend: StorageService = {
  put: (key) => ErrAsync(new StorageUnavailable({ operation: "put", key, reason: "no route" })),
  putIfAbsent: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "putIfAbsent", key, reason: "no route" })),
  putStream: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "putStream", key, reason: "no route" })),
  putStreamIfAbsent: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "putStreamIfAbsent", key, reason: "no route" })),
  get: (key) => ErrAsync(new StorageUnavailable({ operation: "get", key, reason: "no route" })),
  getStream: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "getStream", key, reason: "no route" })),
  copy: (from) =>
    ErrAsync(new StorageUnavailable({ operation: "copy", key: from, reason: "no route" })),
  head: (key) => ErrAsync(new StorageUnavailable({ operation: "head", key, reason: "no route" })),
  delete: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "delete", key, reason: "no route" })),
  presignedUrl: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "presignedUrl", key, reason: "no route" })),
  presignedUpload: (key) =>
    ErrAsync(new StorageUnavailable({ operation: "presignedUpload", key, reason: "no route" })),
};

export const failingStorage = (): Module<StorageBackend, never, never> =>
  Module("FailingStorage")({
    provides: [Provider(StorageBackend)({ inject: {}, value: failingBackend })],
    exports: [StorageBackend],
  });

/** An adapter that defects rather than failing — a client throwing where a `Result` was expected. */
const defectiveBackend: StorageService = {
  ...failingBackend,
  get: () =>
    OkAsync().map((): never => {
      // oxlint-disable-next-line unthrown/no-throw -- `Defect` has no public constructor, so a throw inside a combinator is the only way to mint one, and reaching the defect arm is the whole point of this fixture
      throw new Error("the client blew up");
    }),
};

export const defectiveStorage = (): Module<StorageBackend, never, never> =>
  Module("DefectiveStorage")({
    provides: [Provider(StorageBackend)({ inject: {}, value: defectiveBackend })],
    exports: [StorageBackend],
  });

/** The real S3 adapter over streams that may never run: a pool of no sockets refuses every one. */
export const saturatedStorage = (): Module<StorageBackend, never, never> => {
  const client = new S3Client({
    endpoint: "http://127.0.0.1:1",
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: "none", secretAccessKey: "none" },
  });
  return Module("SaturatedStorage")({
    provides: [
      Provider(StorageBackend)({
        inject: {},
        value: s3StorageBackend(client, "nowhere", { client, maxSockets: 0 }),
      }),
    ],
    exports: [StorageBackend],
  });
};

/**
 * `s3Storage(options)` on the shared RustFS, its service handed to `use` inside
 * the scope, so the clients it built are destroyed by the scope closing — the
 * drain's own path, not a teardown of the fixture's. `extra` adds variables
 * beside the four the store needs.
 */
const scopedS3 = async (
  options: S3StorageOptions,
  extra: { readonly STORAGE_S3_STREAM_MAX_SOCKETS?: string },
  use: (service: StorageService) => Promise<void>,
): Promise<void> => {
  const env = {
    STORAGE_S3_ENDPOINT: inject("__TESTCONTAINERS_S3_ENDPOINT__"),
    STORAGE_S3_BUCKET: inject("__TESTCONTAINERS_S3_BUCKET__"),
    STORAGE_S3_ACCESS_KEY_ID: inject("__TESTCONTAINERS_S3_ACCESS_KEY__"),
    STORAGE_S3_SECRET_ACCESS_KEY: inject("__TESTCONTAINERS_S3_SECRET_KEY__"),
    ...extra,
  };
  const served = await Module.scoped(
    Module("S3Fixture")({
      imports: [s3Storage(options)],
      provides: [Provider(Env)({ inject: {}, value: env })],
      exports: [StorageBackend],
    }),
    (ctx) => fromSafePromise(use(ctx.get(StorageBackend))),
  );

  // A fixture that swallowed a failing scope would leave the test green on
  // a client that never built.
  served.getOrThrow();
};

/** A document a spec can store without restating bytes every time. */
export const aDocument = (): { bytes: Uint8Array; contentType: string } => ({
  bytes: new TextEncoder().encode(`{"ok":true}`),
  contentType: "application/json",
});

/** One MiB, the unit every streamed size in these specs is counted in. */
export const MiB = 1_048_576;

// A full collection before each sample, so what is measured is what a
// transfer still holds rather than garbage the collector has not reached.
// Sampled by bytes moved, not by a timer: a collection every few
// milliseconds starved a loaded runner's transfer.
setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;
const used = (): number => {
  collectGarbage();
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};
let peak = 0;
const sampled = (moved: number): void => {
  if (moved % (32 * MiB) === 0) peak = Math.max(peak, used());
};

/**
 * `size` bytes in 64 KiB chunks, each a fresh buffer filled with its index, so
 * a reordered or dropped chunk changes the digest. `failingAt` errors the
 * stream once that many bytes are out; `cancelled` hears a cancel's reason.
 * Every 32 MiB it sends is a sample of a running `peakGrowth`.
 */
export const aStream = (
  size: number,
  {
    failingAt,
    cancelled,
  }: { readonly failingAt?: number; readonly cancelled?: (reason: unknown) => void } = {},
): ReadableStream<Uint8Array> => {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (failingAt !== undefined && sent >= failingAt) {
        controller.error(new Error("the source broke"));
        return;
      }
      if (sent >= size) {
        controller.close();
        return;
      }
      sampled(sent);
      const length = Math.min(65_536, size - sent);
      controller.enqueue(new Uint8Array(length).fill((sent / 65_536) % 251));
      sent += length;
    },
    cancel: (reason) => cancelled?.(reason),
  });
};

/**
 * What a stream carried, read to its end: its length and its SHA-256. Every
 * 32 MiB it reads is a sample of a running `peakGrowth`.
 */
export const digestOf = async (
  stream: ReadableStream<Uint8Array>,
): Promise<{ readonly size: number; readonly sha256: string }> => {
  const digest = createHash("sha256");
  let size = 0;
  let sampledAt = 0;
  for await (const chunk of stream) {
    digest.update(chunk);
    size += chunk.byteLength;
    if (size - sampledAt >= 32 * MiB) {
      sampledAt = size;
      sampled(0);
    }
  }
  return { size, sha256: digest.digest("hex") };
};

/**
 * `work`'s value, and how far the live heap plus array buffers rose above
 * where they stood before it, sampled as `aStream` and `digestOf` move bytes:
 * a transfer held whole rises by its size.
 */
export const peakGrowth = async <T>(
  work: () => PromiseLike<T>,
): Promise<{ readonly value: T; readonly growth: number }> => {
  const before = used();
  peak = before;
  const value = await work();
  return { value, growth: Math.max(peak, used()) - before };
};

export type Instrumented = {
  readonly run: <T>(
    adapter: Module<StorageBackend, never, never>,
    body: (service: StorageService) => PromiseLike<T>,
  ) => Promise<T>;
  readonly spans: () => readonly ReadableSpan[];
  readonly points: () => readonly DataPoint<number>[];
  readonly lines: () => readonly Line[];
};

export type StorageFixtures = {
  /** The in-memory adapter's service, for a spec that wants no graph. */
  readonly memory: StorageService;
  readonly sdkClient: S3Client;
  /** A plain SDK client on the shared RustFS, for what the port cannot ask: the uploads in progress. */
  readonly rustfs: S3Client;
  readonly bucket: string;
  /** This test's own key space in the shared bucket — a UUID, so nothing collides and nothing needs deleting. */
  readonly keyPrefix: string;
  /** The S3 adapter's service, connected for the length of the test. */
  readonly s3: StorageService;
  /**
   * The S3 adapter with two sockets per pool: `maxSockets` pinned, the stream
   * pool's read from `STORAGE_S3_STREAM_MAX_SOCKETS`.
   */
  readonly pooled: StorageService;
  /** The S3 adapter whose calls must be answered within 1 ms, which none can. */
  readonly hurried: StorageService;
  /** How many HTTP connections the process has opened since the test began. */
  readonly connections: () => number;
  /** The S3 adapter over an endpoint that is not listening — the failure every deployment eventually meets. */
  readonly unreachable: StorageService;
  /** The S3 adapter whose credentials cannot be resolved, which is the one way presigning itself fails. */
  readonly uncredentialed: StorageService;
  /** An instrumented store, and the three signals it emits. */
  readonly instrumented: Instrumented;
};

export const it = test.extend<StorageFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- a fixture with no dependencies still takes vitest's context
  sdkClient: async ({}, use) => {
    const client = new S3Client({
      endpoint: "http://127.0.0.1:1",
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: "none", secretAccessKey: "none" },
    });
    await use(client);
    client.destroy();
  },
  // oxlint-disable-next-line no-empty-pattern -- see below
  rustfs: async ({}, use) => {
    const client = new S3Client({
      endpoint: inject("__TESTCONTAINERS_S3_ENDPOINT__"),
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: inject("__TESTCONTAINERS_S3_ACCESS_KEY__"),
        secretAccessKey: inject("__TESTCONTAINERS_S3_SECRET_KEY__"),
      },
    });
    await use(client);
    client.destroy();
  },
  // oxlint-disable-next-line no-empty-pattern -- see below
  bucket: async ({}, use) => {
    await use(inject("__TESTCONTAINERS_S3_BUCKET__"));
  },
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  memory: async ({}, use) => {
    const served = await Module.scoped(
      Module("MemoryFixture")({
        imports: [storage({ adapter: memoryStorage() })],
        exports: [Storage],
      }),
      (ctx) => fromSafePromise(use(ctx.get(Storage))),
    );
    served.get();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  keyPrefix: async ({}, use) => {
    await use(`test/${randomUUID()}/`);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  connections: async ({}, use) => {
    // Counted where every `http.Agent` opens a socket, so a connection made
    // outside the pool is counted too; restored on every exit path.
    const open = Agent.prototype.createConnection;
    let made = 0;
    Agent.prototype.createConnection = function (this: Agent, ...args) {
      made += 1;
      return open.apply(this, args);
    };
    await use(() => made);
    Agent.prototype.createConnection = open;
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  s3: async ({}, use) => {
    await scopedS3({}, {}, use);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  pooled: async ({}, use) => {
    await scopedS3({ maxSockets: 2 }, { STORAGE_S3_STREAM_MAX_SOCKETS: "2" }, use);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  hurried: async ({}, use) => {
    await scopedS3({ requestTimeoutMs: 1 }, {}, use);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  unreachable: async ({}, use) => {
    // Port 1 refuses immediately, so the arms are reached in milliseconds and
    // without breaking the container every other test is sharing.
    await use(
      s3StorageBackend(
        new S3Client({
          endpoint: "http://127.0.0.1:1",
          region: "us-east-1",
          forcePathStyle: true,
          credentials: { accessKeyId: "none", secretAccessKey: "none" },
          maxAttempts: 1,
        }),
        "nowhere",
      ),
    );
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  uncredentialed: async ({}, use) => {
    // Presigning is a local signature computation, so an unreachable endpoint
    // cannot fail it — the one thing that can is credentials that will not
    // resolve, which is what an unattached IAM role looks like.
    await use(
      s3StorageBackend(
        new S3Client({
          endpoint: "http://127.0.0.1:1",
          region: "us-east-1",
          forcePathStyle: true,
          credentials: () => Promise.reject(new Error("no credentials to be had")),
        }),
        "nowhere",
      ),
    );
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  instrumented: async ({}, use) => {
    // The SDK's env defaults would stand up an OTLP log exporter whose
    // shutdown retries a collector that is not there.
    process.env["OTEL_LOGS_EXPORTER"] = "none";

    const exported: ReadableSpan[] = [];
    // An exporter whose memory survives its own shutdown: the in-memory one
    // OTel ships clears exactly when the flush under test delivers.
    const exporter: SpanExporter = {
      export: (spans, resultCallback) => {
        exported.push(...spans);
        resultCallback({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    const lines: Line[] = [];
    const reader = new PeriodicExportingMetricReader({
      exporter: {
        export: (_metrics, resultCallback) => resultCallback({ code: 0 }),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      exportIntervalMillis: 3_600_000,
    });

    let counted: readonly DataPoint<number>[] = [];
    // Collected INSIDE the scope: closing it shuts the SDK down, and a reader
    // that has been shut down refuses to collect.
    const collect = async (): Promise<void> => {
      const { resourceMetrics } = await reader.collect();
      counted = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === "btravstack.storage.operations")
        .flatMap((metric) => metric.dataPoints as readonly DataPoint<number>[]);
    };

    const run = async <T>(
      adapter: Module<StorageBackend, never, never>,
      body: (service: StorageService) => PromiseLike<T>,
    ): Promise<T> => {
      const served = await Module.scoped(
        Module("InstrumentedFixture")({
          imports: [
            // No flag: the harness exercises the DEFAULT, which is instrumented.
            storage({ adapter }),
            // The real starter over a recording sink, not a hand-built logger:
            // the lines are `observability()`'s own observer now, so a fixture
            // that provided only a `Logger` would record nothing.
            observability({ sink: (line) => lines.push(line), level: "debug" }),
            Module("FixtureEnv")({
              provides: [Provider(Env)({ inject: {}, value: {} })],
              exports: [Env],
            }),
            otel({
              spanProcessors: [
                new BatchSpanProcessor({ exporter, scheduledDelayMillis: 3_600_000 }),
              ],
              metricReader: reader,
            }),
          ],
          exports: [Storage],
        }),
        (ctx) =>
          fromSafePromise(
            Promise.resolve(body(ctx.get(Storage))).then(async (value) => {
              await collect();
              return value;
            }),
          ),
      );

      // `get`, not `getOrThrow`: this graph's error channel is `never`.
      return served.getOrThrow();
    };

    await use({ run, spans: () => exported, points: () => counted, lines: () => lines });

    // The api's globals register ONCE per process; without this, only the
    // first test's SDK would ever receive anything.
    trace.disable();
    metrics.disable();
    delete process.env["OTEL_LOGS_EXPORTER"];
  },
});
