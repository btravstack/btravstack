import {
  Instrumentations,
  Meter,
  Observers,
  SPAN_STATUS,
  Tracer,
  observed,
} from "@btravstack/core";
import { Module, Port, Provider, type Context } from "@btravstack/di";
import {
  TestRuntimePort,
  bootFixture,
  createFakeClock,
  testRuntime,
  type Boot,
} from "@btravstack/testing";
import { metrics, trace } from "@opentelemetry/api";
import { metrics as sdkMetrics } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { Err, Ok, OkAsync, fromSafePromise } from "unthrown";
import { describe, expect, test } from "vitest";

import { UnitSpan, UnitSpanModule, otel } from "./otel.js";

/**
 * An exporter whose memory SURVIVES its own shutdown — `InMemorySpanExporter`
 * clears on `shutdown()`, which is exactly when the flush under test delivers.
 */
type Keeper = { readonly exporter: SpanExporter; readonly seen: () => readonly ReadableSpan[] };

const it = test.extend<{ boot: Boot; spans: Keeper }>({
  boot: bootFixture(),
  // oxlint-disable-next-line no-empty-pattern -- depends on no other fixture
  spans: async ({}, use) => {
    // Without these, the SDK's env defaults stand up OTLP metric and log
    // exporters whose shutdown retries a collector that is not there — the
    // spans pipeline is the only one under test here.
    process.env["OTEL_METRICS_EXPORTER"] = "none";
    process.env["OTEL_LOGS_EXPORTER"] = "none";
    const kept: ReadableSpan[] = [];
    await use({
      exporter: {
        export: (spans, resultCallback) => {
          kept.push(...spans);
          resultCallback({ code: 0 });
        },
        shutdown: () => Promise.resolve(),
      },
      seen: () => kept,
    });
    // The api's globals register ONCE per process; without this, only the
    // first test's SDK would ever receive a span. One `otel()` per process is
    // the real-world contract too — the SDK's own.
    trace.disable();
    metrics.disable();
    delete process.env["OTEL_METRICS_EXPORTER"];
    delete process.env["OTEL_LOGS_EXPORTER"];
  },
});

/** An hour of batch delay: a span reaches the exporter only if shutdown flushed. */
const batchedOtel = (spans: Keeper) =>
  otel({
    spanProcessors: [
      new BatchSpanProcessor({ exporter: spans.exporter, scheduledDelayMillis: 3_600_000 }),
    ],
  });

describe("otel", () => {
  it("opens a span per unit and flushes it out on the scope's close", async ({ boot, spans }) => {
    // GIVEN an app whose unit module opens a span, exporting through a batch
    // processor an hour from its next scheduled export
    const runtime = testRuntime("test", { unit: UnitSpanModule });
    const App = Module("OtelApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer],
    });
    const clock = createFakeClock();
    const app = boot(App, { clock });
    await runtime.untilStarted();

    // WHEN a unit runs and the app exits — the flush window — with the
    // pre-drain delay advanced on a clock the test owns, never waited
    const unit = runtime.submit<string>();
    unit.settle(Ok("done"));
    await unit.result;
    app.requestDrain();
    await clock.advance(5_000);
    await app.exited;

    // THEN the span left the process anyway — release flushed it — named for
    // the unit and correlated with the ambient record's own ids
    const exported = spans.seen().map((span) => ({
      name: span.name,
      unitCorrelated: typeof span.attributes["btravstack.unit_id"] === "string",
      traceCorrelated: typeof span.attributes["btravstack.trace_id"] === "string",
    }));
    expect(exported).toEqual([{ name: "unit", unitCorrelated: true, traceCorrelated: true }]);
  });

  it("marks the span of a unit whose work failed", async ({ boot, spans }) => {
    // GIVEN a serving app whose unit module opens a span
    const runtime = testRuntime("test", { unit: UnitSpanModule });
    const App = Module("OtelFailedApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer],
    });
    const clock = createFakeClock();
    const app = boot(App, { clock });
    await runtime.untilStarted();

    // WHEN a unit settles Err and the app exits, flushing the span
    const unit = runtime.submit<string, "declined">();
    unit.settle(Err("declined"));
    await unit.result;
    app.requestDrain();
    await clock.advance(5_000);
    await app.exited;

    // THEN the unit's span says it failed
    expect(spans.seen().map((span) => ({ name: span.name, status: span.status }))).toEqual([
      { name: "unit", status: { code: SPAN_STATUS.error } },
    ]);
  });

  it("marks the span of a unit the kernel aborted", async ({ boot, spans }) => {
    // GIVEN a serving app whose unit module opens a span, with one unit open
    const runtime = testRuntime("test", { unit: UnitSpanModule });
    const App = Module("OtelAbortedApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer],
    });
    const clock = createFakeClock();
    const app = boot(App, { clock });
    await runtime.untilStarted();
    const unit = runtime.submit<string>();
    unit.signal.addEventListener("abort", () => unit.settle(Ok("late")), { once: true });

    // WHEN a drain runs out its deadline — which aborts the open unit — and
    // the work answers the abort by finishing anyway
    app.requestDrain();
    await clock.advance(5_000);
    await clock.advance(20_000);
    await app.exited;

    // THEN the unit's span says it was aborted, whatever the work answered
    expect(spans.seen().map((span) => ({ name: span.name, status: span.status }))).toEqual([
      { name: "unit", status: { code: SPAN_STATUS.error, message: "aborted" } },
    ]);
  });

  it("marks the span of a unit whose scope failed to build", async ({ boot, spans }) => {
    // GIVEN a unit module whose sibling provider throws once the span is open
    class Doomed extends Port("OtelSpecDoomed")<string> {}
    const DoomedUnit = Module("OtelSpecDoomedUnit")({
      imports: [UnitSpanModule],
      provides: [
        Provider(Doomed)({
          inject: { span: UnitSpan },
          sync: () => {
            // oxlint-disable-next-line unthrown/no-throw -- the subject under test: a fork whose construction fails after the unit span opened
            throw new Error("construction-boom");
          },
        }),
      ],
      exports: [Doomed],
    });
    const runtime = testRuntime("test", { unit: DoomedUnit });
    const App = Module("OtelDoomedApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer],
    });
    const clock = createFakeClock();
    const app = boot(App, { clock });
    await runtime.untilStarted();

    // WHEN a unit's fork fails to build — its partial scope is torn down
    // before the work has settled — and the app exits, flushing the span
    await runtime.submit<string>().result;
    app.requestDrain();
    await clock.advance(5_000);
    await app.exited;

    // THEN the unit's span says it failed, rather than ending unmarked
    expect(spans.seen().map((span) => ({ name: span.name, status: span.status }))).toEqual([
      { name: "unit", status: { code: SPAN_STATUS.error } },
    ]);
  });

  it("parents an operation started before the unit span on it, whatever the import order", async ({
    boot,
    spans,
  }) => {
    // GIVEN a unit module importing a provider that reads the cache while it
    // is built, listed BEFORE the span module — so di starts it first
    class Warmed extends Port("OtelSpecWarmed")<string> {}
    const Warmer = Module("OtelSpecWarmer")({
      needs: [Observers],
      provides: [
        Provider(Warmed)({
          inject: { observers: Observers },
          make: ({ observers }) =>
            observed(observers, { component: "cache", name: "get", attributes: {} }, () =>
              fromSafePromise(Promise.resolve("hit")),
            ),
        }),
      ],
      exports: [Warmed],
    });
    const WarmUnit = Module("OtelSpecWarmUnit")({
      imports: [Warmer, UnitSpanModule],
      exports: [Warmed, UnitSpan],
    });
    const runtime = testRuntime("test", { unit: WarmUnit });
    const App = Module("OtelWarmApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer, Observers],
    });
    const clock = createFakeClock();
    const app = boot(App, { clock });
    await runtime.untilStarted();

    // WHEN a unit runs to completion and the app exits, flushing the spans
    const unit = runtime.submit<string>();
    unit.settle(Ok("done"));
    await unit.result;
    app.requestDrain();
    await clock.advance(5_000);
    await app.exited;

    // THEN the read is still the unit span's child
    const byName = new Map(spans.seen().map((span) => [span.name, span]));
    expect({
      names: [...byName.keys()].toSorted(),
      childOfUnit:
        byName.get("cache.get")?.parentSpanContext?.spanId ===
        byName.get("unit")?.spanContext().spanId,
    }).toEqual({ names: ["cache.get", "unit"], childOfUnit: true });
  });

  it("parents an operation inside a unit on that unit's span", async ({ boot, spans }) => {
    // GIVEN a serving app with the SDK composed, and a unit that forks the
    // span module and then runs a cache read the way `@btravstack/cache` does
    const runtime = testRuntime("test");
    const App = Module("OtelParentApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer, Observers],
    });
    const clock = createFakeClock();
    const app = boot(App, { clock });
    await runtime.untilStarted();
    const observers = (runtime.host().ctx as unknown as Context<Observers>).get(Observers);

    // WHEN the unit runs to completion and the app exits, flushing the spans
    await runtime
      .host()
      .run({ kind: "test", id: "parented" }, (unit) =>
        unit
          .fork(UnitSpanModule as never, [])
          .flatMap(() =>
            observed(observers, { component: "cache", name: "get", attributes: {} }, () =>
              OkAsync("hit"),
            ),
          ),
      );
    app.requestDrain();
    await clock.advance(5_000);
    await app.exited;

    // THEN the read is the unit span's child, in its trace, carrying its ids
    const byName = new Map(spans.seen().map((span) => [span.name, span]));
    const read = byName.get("cache.get");
    const unit = byName.get("unit");
    expect({
      names: [...byName.keys()].toSorted(),
      childOfUnit: read?.parentSpanContext?.spanId === unit?.spanContext().spanId,
      sameTrace: read?.spanContext().traceId === unit?.spanContext().traceId,
      unitId: read?.attributes["btravstack.unit_id"],
      sameUnit: read?.attributes["btravstack.unit_id"] === unit?.attributes["btravstack.unit_id"],
    }).toEqual({
      names: ["cache.get", "unit"],
      childOfUnit: true,
      sameTrace: true,
      unitId: expect.any(String),
      sameUnit: true,
    });
  });

  it("opens an unattributed span when no ambient unit is present", async ({ spans }) => {
    // GIVEN the otel module built outside any unit, and the span module
    // forked over it by hand
    const result = await Module.scoped(batchedOtel(spans), (ctx) =>
      Module.forkScope(ctx, UnitSpanModule, (fork) => {
        fork.get(UnitSpan);
        return OkAsync("forked");
      }),
    );

    // THEN the fork ran and the span carried no unit attributes — read after
    // the scope closed, which is what ended and flushed it
    const projected = {
      result,
      spans: spans.seen().map((span) => ({
        name: span.name,
        attributed: "btravstack.unit_id" in span.attributes,
      })),
    };
    expect(projected).toEqual({
      result: expect.objectContaining({ value: "forked" }),
      spans: [{ name: "unit", attributed: false }],
    });
  });

  it("hands back OTel's own meter, ready to count", async ({ spans }) => {
    // GIVEN the otel module built and its Meter read
    const counted = await Module.scoped(batchedOtel(spans), (ctx) => {
      const counter = ctx.get(Meter).createCounter("otel.spec.count");
      counter.add(1);
      return OkAsync("counted");
    });

    // THEN the meter accepted the count without a throw
    expect(counted).toBeOkWith("counted");
  });

  it("records an operation's duration in seconds, on seconds buckets", async ({ spans }) => {
    // GIVEN the otel module collecting metrics through a reader the test owns
    const reader = new (class extends sdkMetrics.MetricReader {
      protected onShutdown = (): Promise<void> => Promise.resolve();
      protected onForceFlush = (): Promise<void> => Promise.resolve();
    })();

    // WHEN an operation is observed and the meter collected
    const collected = await Module.scoped(
      otel({
        spanProcessors: [new BatchSpanProcessor({ exporter: spans.exporter })],
        metricReaders: [reader],
      }),
      (ctx) =>
        observed(ctx.get(Observers), { component: "cache", name: "get", attributes: {} }, () =>
          OkAsync("hit"),
        ).flatMap(() => fromSafePromise(reader.collect())),
    );

    // THEN the histogram is in seconds, bucketed for seconds, and an instant
    // operation lands under a second
    const histogram = collected
      .map(({ resourceMetrics }) =>
        resourceMetrics.scopeMetrics
          .flatMap((scope) => scope.metrics)
          .find((metric) => metric.descriptor.name === "btravstack.cache.duration"),
      )
      .map((metric) => {
        const point = metric?.dataPoints[0]?.value as sdkMetrics.Histogram | undefined;
        return {
          unit: metric?.descriptor.unit,
          firstBoundary: point?.buckets.boundaries[0],
          underASecond: (point?.sum ?? Infinity) < 1,
        };
      });
    expect(histogram).toBeOkWith({ unit: "s", firstBoundary: 0.005, underASecond: true });
  });

  it("registers an instrumentation a starter contributed", async ({ spans }) => {
    // GIVEN a package offering an instrumentation, the shape a starter
    // contributes — the SDK wires a provider into whatever it registers
    let wired = false;
    const offered = {
      instrumentationName: "@btravstack/spec-instrumentation",
      instrumentationVersion: "0.0.0",
      enable: () => {},
      disable: () => {},
      setConfig: () => {},
      getConfig: () => ({}),
      setTracerProvider: () => {
        wired = true;
      },
      setMeterProvider: () => {},
    };
    const contributor = Module("Contributor")({
      provides: [
        Provider.member(Instrumentations)({ inject: {}, value: () => Promise.resolve(offered) }),
      ],
      exports: [Instrumentations],
    });

    // WHEN a graph composes both the contributor and the SDK
    const built = await Module.scoped(
      Module("Root")({
        imports: [contributor, batchedOtel(spans)],
        exports: [Tracer],
      }),
      (ctx) => OkAsync(ctx.get(Tracer)),
    );

    // THEN the SDK took the contribution and wired its tracer provider in —
    // nothing in the application named the instrumentation
    expect({ ok: built.isOk(), wired }).toEqual({ ok: true, wired: true });
  });
});
