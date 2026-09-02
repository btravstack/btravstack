import { Env } from "@btravstack/config";
import { Observers, type Operation, type Settled } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { trace } from "@opentelemetry/api";
import { BatchSpanProcessor, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace";
import { fromSafePromise } from "unthrown";
import { describe, expect, test } from "vitest";

import type { Line } from "./logger.js";
import { observability } from "./observability.js";
import { otel } from "./otel.js";

type Observed = {
  readonly run: (operation: Operation, settled: Settled) => Promise<void>;
  readonly lines: () => readonly Line[];
  readonly spans: () => readonly ReadableSpan[];
};

const it = test.extend<{ observed: Observed }>({
  // oxlint-disable-next-line no-empty-pattern -- depends on no other fixture
  observed: async ({}, use) => {
    // Without these the SDK stands up default OTLP metric and log exporters
    // whose shutdown retries a collector that is not there; spans are the only
    // pipeline this file reads.
    process.env["OTEL_LOGS_EXPORTER"] = "none";
    process.env["OTEL_METRICS_EXPORTER"] = "none";
    const exported: ReadableSpan[] = [];
    const exporter: SpanExporter = {
      export: (spans, resultCallback) => {
        exported.push(...spans);
        resultCallback({ code: 0 });
      },
      shutdown: () => Promise.resolve(),
    };
    const lines: Line[] = [];

    await use({
      run: async (operation, settled) => {
        await Module.scoped(
          Module("Observed")({
            imports: [
              observability({ sink: (line) => lines.push(line), level: "debug" }),
              otel({
                spanProcessors: [
                  new BatchSpanProcessor({ exporter, scheduledDelayMillis: 3_600_000 }),
                ],
              }),
              Module("FixtureEnv")({
                provides: [Provider(Env)({ inject: {}, value: {} })],
                exports: [Env],
              }),
            ],
            exports: [Observers],
          }),
          (ctx) =>
            fromSafePromise(
              (async () => {
                for (const observer of ctx.get(Observers)) observer(operation)(settled);
                await Promise.resolve();
              })(),
            ),
        );
        await Promise.resolve();
      },
      lines: () => lines,
      spans: () => exported,
    });

    trace.disable();
  },
});

describe("the observers observability composes", () => {
  it("names the span after the component", async ({ observed }) => {
    // GIVEN an operation from a component the observers know nothing about
    // WHEN it is observed and settles
    await observed.run(
      { component: "cache", name: "get", attributes: { operation: "get" }, details: { key: "k" } },
      { outcome: "ok" },
    );

    // THEN the span name is derived from the component, which is why nothing
    // had to become uniform to be shared. The instruments follow the same rule
    // and are asserted where a metric reader is installed —
    // `@btravstack/cache`'s own spec still reads `btravstack.cache.operations`
    expect(observed.spans().map((span) => span.name)).toEqual(["cache.get"]);
  });

  it("puts details on the span and keeps them off the instruments", async ({ observed }) => {
    // GIVEN an operation whose detail is unbounded — a cache key
    // WHEN it is observed
    await observed.run(
      { component: "cache", name: "get", attributes: { operation: "get" }, details: { key: "k" } },
      { outcome: "ok" },
    );

    // THEN the key rides the span. That it does NOT ride the instrument is
    // `@btravstack/cache`'s spec, which reads the counter's attributes: one
    // more field on a span, one time series per key on a metric
    expect(observed.spans()[0]?.attributes).toEqual({ operation: "get", key: "k" });
  });

  it("opens no span when the operation declines one", async ({ observed }) => {
    // GIVEN a component whose spans come from somewhere better — Prisma's
    // engine-level instrumentation
    // WHEN it is observed
    await observed.run(
      { component: "database", name: "findMany", attributes: {}, traced: false },
      { outcome: "ok" },
    );

    // THEN nothing was traced: whether a span is worth opening is the
    // CONTRIBUTOR's knowledge, and this one knows its spans come from Prisma's
    // engine-level instrumentation instead
    expect(observed.spans()).toEqual([]);
  });

  it("writes a failure as an error line carrying the cause", async ({ observed }) => {
    // GIVEN an operation that fails
    const cause = new Error("the backend is gone");

    // WHEN it settles as an error
    await observed.run(
      { component: "cache", name: "get", attributes: { operation: "get" }, details: { key: "k" } },
      { outcome: "error", cause },
    );

    // THEN one error line names the component and the operation and carries
    // the detail — a starter says WHAT happened, the observer says how to
    // record it
    expect(observed.lines()).toEqual([
      expect.objectContaining({
        level: "error",
        message: "cache.get failed",
        attributes: expect.objectContaining({ operation: "get", key: "k" }),
        // By identity: the line carries the ORIGINAL failure, not a
        // reconstruction of it.
        cause,
      }),
    ]);
  });

  it("writes no line for a success, since the metric is what counts it", async ({ observed }) => {
    // GIVEN an operation that succeeds
    // WHEN it settles
    await observed.run(
      { component: "mail", name: "send", attributes: { operation: "send" } },
      { outcome: "ok" },
    );

    // THEN nothing is logged. A line per success was tried and reverted: it
    // broke an application spec asserting that neither its controller nor its
    // interactor had written anything, which is an absence worth being able to
    // assert
    expect(observed.lines()).toEqual([]);
  });
});
