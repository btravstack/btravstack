import { Meter, Tracer } from "@btravstack/core";
import { Module } from "@btravstack/di";
import {
  TestRuntimePort,
  bootFixture,
  createFakeClock,
  testRuntime,
  type Boot,
} from "@btravstack/testing";
import { metrics, trace } from "@opentelemetry/api";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { Ok } from "unthrown";
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
    const runtime = testRuntime();
    const App = Module("OtelApp")({
      imports: [batchedOtel(spans), runtime.module],
      exports: [TestRuntimePort, Tracer],
    });
    const clock = createFakeClock();
    const app = boot(App, { unit: UnitSpanModule, clock });
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

  it("opens an unattributed span when no ambient unit is present", async ({ spans }) => {
    // GIVEN the otel module built outside any unit, and the span module
    // forked over it by hand
    const result = await Module.scoped(batchedOtel(spans), (ctx) =>
      Module.forkScope(ctx, UnitSpanModule, (fork) => {
        fork.get(UnitSpan);
        return Ok("forked").toAsync();
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
      return Ok("counted").toAsync();
    });

    // THEN the meter accepted the count without a throw
    expect(counted).toBeOkWith("counted");
  });
});
