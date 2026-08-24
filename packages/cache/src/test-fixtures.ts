import { randomUUID } from "node:crypto";

import { Env } from "@btravstack/config";
import { Logger } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { createLogger, type Line } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { createFakeClock, type FakeClock } from "@btravstack/testing";
import { metrics, trace } from "@opentelemetry/api";
import { PeriodicExportingMetricReader, type DataPoint } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { ErrAsync, OkAsync, fromSafePromise } from "unthrown";
import { inject, test } from "vitest";

import {
  Cache,
  CacheBackend,
  CacheUnavailable,
  type CacheHit,
  type CacheService,
} from "./cache.js";
import { memoryCacheBackend } from "./memory.js";
import { cache } from "./module.js";
import { redisCache } from "./redis.js";

/** An adapter that is always down, so the failure arms are reachable without breaking the shared server. */
const failingBackend: CacheService = {
  get: (key) => ErrAsync(new CacheUnavailable({ operation: "get", key })),
  set: (key) => ErrAsync(new CacheUnavailable({ operation: "set", key })),
  delete: (key) => ErrAsync(new CacheUnavailable({ operation: "delete", key })),
};

/** That adapter as a module, so it composes exactly where `memoryCache()` would. */
export const failingCache = (): Module<CacheBackend, never, never> =>
  Module("FailingCache")({
    provides: [Provider(CacheBackend)({ value: failingBackend })],
    exports: [CacheBackend],
  });

/**
 * An adapter that defects rather than failing — the shape a value
 * `JSON.stringify` cannot take produces, which the port deliberately does not
 * model.
 */
const defectiveBackend: CacheService = {
  get: () =>
    OkAsync().map((): CacheHit | undefined => {
      // oxlint-disable-next-line unthrown/no-throw -- `Defect` has no public constructor, so a throw inside a combinator is the only way to mint one, and reaching the defect arm is the whole point of this fixture
      throw new Error("the value could not be encoded");
    }),
  set: () => OkAsync(),
  delete: () => OkAsync(),
};

export const defectiveCache = (): Module<CacheBackend, never, never> =>
  Module("DefectiveCache")({
    provides: [Provider(CacheBackend)({ value: defectiveBackend })],
    exports: [CacheBackend],
  });

/**
 * What an instrumented cache left behind: the spans it exported, the counter
 * points it recorded, and the lines it logged.
 *
 * One harness rather than three fixtures, because the three are three
 * readings of ONE graph — wiring them separately would mean standing the SDK
 * up more than once per test.
 */
export type Instrumented = {
  /** Runs a body against an instrumented cache over `adapter`, in a scope of its own. */
  readonly run: <T>(
    adapter: Module<CacheBackend, never, never>,
    // `PromiseLike`, not `Promise`: a body is usually one `AsyncResult`
    // expression, and an `AsyncResult` is thenable without being a Promise.
    body: (service: CacheService) => PromiseLike<T>,
  ) => Promise<T>;
  readonly spans: () => readonly ReadableSpan[];
  readonly points: () => readonly DataPoint<number>[];
  readonly lines: () => readonly Line[];
};

export type CacheFixtures = {
  /** The clock the memory adapter measures a ttl against, so an expiry needs no real wait. */
  readonly clock: FakeClock;
  /** The in-memory adapter's service, on that clock. */
  readonly backend: CacheService;
  /** This test's own key space on the shared server — a UUID, so nothing collides and nothing needs cleaning up. */
  readonly keyPrefix: string;
  /** The Redis adapter's service, connected for the length of the test. */
  readonly redis: CacheService;
  /** The same service, after its scope closed — the shape an adapter takes when the server is gone. */
  readonly disconnected: CacheService;
  /** An instrumented cache, and the three signals it emits. */
  readonly instrumented: Instrumented;
};

export const it = test.extend<CacheFixtures>({
  // oxlint-disable-next-line no-empty-pattern -- vitest's fixture signature: one that names no other fixture still takes the destructured first parameter
  clock: async ({}, use) => {
    await use(createFakeClock());
  },
  backend: async ({ clock }, use) => {
    await use(memoryCacheBackend({ clock }));
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  keyPrefix: async ({}, use) => {
    await use(`test:${randomUUID()}:`);
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  redis: async ({}, use) => {
    const env = { REDIS_URL: inject("__TESTCONTAINERS_REDIS_URL__") };
    const served = await Module.scoped(
      Module("RedisCacheFixture")({
        imports: [redisCache()],
        provides: [Provider(Env)({ value: env })],
        exports: [CacheBackend],
      }),
      // `use` runs INSIDE the scope, so the connection the provider acquired
      // is closed by the scope closing — the same path a real application's
      // drain takes, rather than a teardown of the fixture's own.
      (ctx) => fromSafePromise(use(ctx.get(CacheBackend))),
    );

    // A fixture that swallowed a failing scope would leave the test green on
    // a connection that never opened.
    served.getOrThrow();
  },
  // oxlint-disable-next-line no-empty-pattern -- see above
  disconnected: async ({}, use) => {
    // The service outlives its scope on purpose: the scope closing is what
    // closes the connection, so what the test holds afterwards is an adapter
    // whose server is unreachable — the state `CacheUnavailable` exists to
    // describe, reached without touching the shared container.
    const env = { REDIS_URL: inject("__TESTCONTAINERS_REDIS_URL__") };
    const served = await Module.scoped(
      Module("DisconnectedCacheFixture")({
        imports: [redisCache()],
        provides: [Provider(Env)({ value: env })],
        exports: [CacheBackend],
      }),
      (ctx) => OkAsync(ctx.get(CacheBackend)),
    );

    await use(served.getOrThrow());
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
    // Nothing pushes metrics anywhere: `reader.collect()` is what a test
    // reads, so the export interval is an hour away and never fires.
    const reader = new PeriodicExportingMetricReader({
      exporter: {
        export: (_metrics, resultCallback) => resultCallback({ code: 0 }),
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
      exportIntervalMillis: 3_600_000,
    });

    let counted: readonly DataPoint<number>[] = [];
    // Collected INSIDE the scope: closing it shuts the SDK down, and a
    // reader that has been shut down refuses to collect. So the reading
    // happens where the instruments are still alive — right after the body,
    // before release.
    const collect = async (): Promise<void> => {
      const { resourceMetrics } = await reader.collect();
      counted = resourceMetrics.scopeMetrics
        .flatMap((scope) => scope.metrics)
        .filter((metric) => metric.descriptor.name === "btravstack.cache.operations")
        .flatMap((metric) => metric.dataPoints as readonly DataPoint<number>[]);
    };

    const run = async <T>(
      adapter: Module<CacheBackend, never, never>,
      body: (service: CacheService) => PromiseLike<T>,
    ): Promise<T> => {
      const served = await Module.scoped(
        Module("InstrumentedFixture")({
          imports: [
            cache({ adapter, instrumented: true }),
            Module("RecordingLogger")({
              provides: [
                Provider(Logger)({ value: createLogger((line) => lines.push(line), "debug") }),
              ],
              exports: [Logger],
            }),
            otel({
              spanProcessors: [
                new BatchSpanProcessor({ exporter, scheduledDelayMillis: 3_600_000 }),
              ],
              metricReader: reader,
            }),
          ],
          exports: [Cache],
        }),
        (ctx) =>
          fromSafePromise(
            Promise.resolve(body(ctx.get(Cache))).then(async (value) => {
              await collect();
              return value;
            }),
          ),
      );

      // `get`, not `getOrThrow`: this graph's error channel is `never`, and
      // unthrown refuses the throwing read when there is nothing to throw.
      return served.get();
    };

    await use({
      run,
      spans: () => exported,
      points: () => counted,
      lines: () => lines,
    });

    // The api's globals register ONCE per process; without this, only the
    // first test's SDK would ever receive anything.
    trace.disable();
    metrics.disable();
    delete process.env["OTEL_LOGS_EXPORTER"];
  },
});
