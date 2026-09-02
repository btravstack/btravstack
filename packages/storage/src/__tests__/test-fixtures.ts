import { randomUUID } from "node:crypto";

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
import { s3Storage, s3StorageBackend } from "../s3.js";
import { Storage, StorageBackend, StorageUnavailable, type StorageService } from "../storage.js";

/** An adapter whose store is down, so the failure arms are reachable without breaking the shared one. */
const failingBackend: StorageService = {
  put: (key) => ErrAsync(new StorageUnavailable({ operation: "put", key, reason: "no route" })),
  get: (key) => ErrAsync(new StorageUnavailable({ operation: "get", key, reason: "no route" })),
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

/** A document a spec can store without restating bytes every time. */
export const aDocument = (): { bytes: Uint8Array; contentType: string } => ({
  bytes: new TextEncoder().encode(`{"ok":true}`),
  contentType: "application/json",
});

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
  /** This test's own key space in the shared bucket — a UUID, so nothing collides and nothing needs deleting. */
  readonly keyPrefix: string;
  /** The S3 adapter's service, connected for the length of the test. */
  readonly s3: StorageService;
  /** The S3 adapter over an endpoint that is not listening — the failure every deployment eventually meets. */
  readonly unreachable: StorageService;
  /** The S3 adapter whose credentials cannot be resolved, which is the one way presigning itself fails. */
  readonly uncredentialed: StorageService;
  /** An instrumented store, and the three signals it emits. */
  readonly instrumented: Instrumented;
};

export const it = test.extend<StorageFixtures>({
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
  s3: async ({}, use) => {
    const env = {
      STORAGE_S3_ENDPOINT: inject("__TESTCONTAINERS_S3_ENDPOINT__"),
      STORAGE_S3_BUCKET: inject("__TESTCONTAINERS_S3_BUCKET__"),
      STORAGE_S3_ACCESS_KEY_ID: inject("__TESTCONTAINERS_S3_ACCESS_KEY__"),
      STORAGE_S3_SECRET_ACCESS_KEY: inject("__TESTCONTAINERS_S3_SECRET_KEY__"),
    };
    const served = await Module.scoped(
      Module("S3Fixture")({
        imports: [s3Storage()],
        provides: [Provider(Env)({ inject: {}, value: env })],
        exports: [StorageBackend],
      }),
      // `use` runs INSIDE the scope, so the client the provider built is
      // destroyed by the scope closing — the drain's own path, not a
      // teardown of the fixture's.
      (ctx) => fromSafePromise(use(ctx.get(StorageBackend))),
    );

    // A fixture that swallowed a failing scope would leave the test green on
    // a client that never built.
    served.getOrThrow();
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
