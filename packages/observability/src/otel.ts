import {
  Instrumentations,
  Meter,
  Observers,
  SPAN_STATUS,
  Tracer,
  currentUnit,
  unitOutcome,
  type Attributes,
  type Counter,
  type Histogram,
  type Span,
  type UnitRecord,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope } from "@btravstack/di";
import { context, metrics, trace, type Span as OtelSpan } from "@opentelemetry/api";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { fromSafePromise } from "unthrown";

/**
 * The tracing half of observability — the ADAPTER, not the contract. `Tracer`
 * and `Meter` are the kernel's ports, and OTel's presence stops at this subpath,
 * behind an optional peer exactly like `pino`.
 *
 * The ports are narrowings of OTel's own shapes, so what the SDK hands back
 * satisfies them with no translation in between.
 */

/**
 * The SDK itself, module-private: providing it is what starts it, and `release`
 * is what flushes it. It rides the graph as a RESOURCE so the kernel closes it
 * on every exit path — a span lost in `shutdown()` becomes a `teardownError` and
 * exit `2`, never silence.
 */
// Reached by index rather than imported: `@opentelemetry/instrumentation` is
// not a dependency here, and `sdk-node` already names the type this list must
// satisfy.
type SdkInstrumentations = NodeSDKConfiguration["instrumentations"];

class OtelSdk extends Port("OtelSdk")<NodeSDK> {}

/**
 * OTel semantic conventions' duration buckets, in seconds. The SDK's default
 * boundaries were drawn for milliseconds and would put every operation under a
 * second into the first bucket.
 */
const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

/**
 * Each open unit's span, by the record it was opened for — so an operation
 * inside the unit parents on it while the observer still injects nothing.
 * Weak, so an ended unit costs nothing once its record is gone.
 */
const unitSpans = new WeakMap<UnitRecord, OtelSpan>();

const unitAttributes = (unit: UnitRecord | undefined): Attributes =>
  unit === undefined
    ? {}
    : {
        "btravstack.unit_id": unit.unitId,
        "btravstack.trace_id": unit.traceId,
        ...(unit.tenantId === undefined ? {} : { "btravstack.tenant_id": unit.tenantId }),
      };

/**
 * The OTel starter: a module providing `Tracer` and `Meter` over a `NodeSDK`
 * opened with the scope and flushed on close. Compose it beside
 * `observability()` in a root's `imports`.
 *
 * **No config slice, deliberately**: the SDK reads the `OTEL_*` environment
 * conventions itself, and re-binding them through `Config` would be a second
 * spelling of names operators already know. Programmatic overrides go through
 * `options`, the SDK's own configuration type.
 *
 * **Auto-instrumentation cannot live here**: the register hook must be
 * preloaded before the instrumented libraries are imported, which no DI
 * provider can promise. Preloading is the deployment's line.
 *
 * **What CAN live here is a starter's own instrumentation.** Every package
 * that contributed to `Instrumentations` is loaded and handed to the SDK, so
 * composing a starter is what declares the instrumentation and composing this
 * is what turns it on. A contribution whose optional peer is not installed
 * loads as `undefined` and is dropped — the contributor says so at `debug`,
 * since it is the one that knows why.
 *
 * The module contributes one member of its own, which loads nothing. That is
 * what makes `Instrumentations` a port the graph always has — a collector
 * depending on a set port NOTHING provides is an unmet dependency, both at
 * plan time and in `Needs`. Guice's `newSetBinder` declares the empty set for
 * the same reason.
 */
export const otel = (
  options?: Partial<NodeSDKConfiguration>,
): Module<Tracer | Meter | Observers, never, Scope> =>
  Module("Otel")({
    provides: [
      Provider.member(Instrumentations)({ inject: {}, value: () => Promise.resolve(undefined) }),
      // The span, the count and the timing of every observed operation — the
      // three a component would otherwise hold a `Tracer` and a `Meter` to do
      // itself. Instruments are minted PER COMPONENT and cached, so a starter
      // still gets `btravstack.cache.operations` rather than one metric with a
      // component label: the observer derives the name from the operation, so
      // nothing had to become uniform to be shared.
      // **Injects nothing, and reads the OTel globals per operation instead.**
      // Depending on `Tracer`/`Meter` here is a dependency CYCLE: `OtelSdk`
      // collects `Instrumentations`, a starter's instrumentation contribution
      // may read `Observers`, and this member would then close the loop back
      // onto the SDK. Reading the globals is also what makes the ordering free
      // — an operation is observed long after `sdk.start()`, so there is
      // nothing left to order.
      Provider.member(Observers)({
        inject: {},
        sync: () => {
          const tracer = trace.getTracer("@btravstack/observability");
          const counters = new Map<string, Counter>();
          const durations = new Map<string, Histogram>();
          const instrument = <T>(cache: Map<string, T>, key: string, make: () => T): T => {
            const existing = cache.get(key);
            if (existing !== undefined) return existing;
            const minted = make();
            cache.set(key, minted);
            return minted;
          };

          return ({ component, name, attributes, details, traced }) => {
            // The METER is read per operation, not once: `trace.getTracer`
            // answers a proxy that resolves when the SDK registers, and
            // `metrics.getMeter` does not — read once before `sdk.start()` it
            // returns the no-op meter and keeps it forever. The instruments it
            // mints are still cached, which is the part worth doing once.
            const meter = metrics.getMeter("@btravstack/observability");
            // The ambient record is read per operation too, since one observer
            // serves every unit.
            const unit = currentUnit();
            const parent = unit === undefined ? undefined : unitSpans.get(unit);
            const span =
              traced === false
                ? undefined
                : tracer.startSpan(
                    `${component}.${name}`,
                    {},
                    parent === undefined ? undefined : trace.setSpan(context.active(), parent),
                  );
            // Details ride the SPAN and not the instruments: a cache key or a
            // URL is one more field on a span and one more time series on a
            // metric.
            span?.setAttributes({ ...attributes, ...details, ...unitAttributes(unit) });
            const startedAt = performance.now();
            const operations = instrument(counters, component, () =>
              meter.createCounter(`btravstack.${component}.operations`, {
                description: `${component} operations, by operation and outcome`,
              }),
            );
            const duration = instrument(durations, component, () =>
              meter.createHistogram(`btravstack.${component}.duration`, {
                description: `${component} operation duration`,
                unit: "s",
                advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
              }),
            );

            return ({ outcome, attributes: settled }) => {
              const all = { ...attributes, ...settled, outcome };
              operations.add(1, all);
              duration.record((performance.now() - startedAt) / 1000, all);
              if (outcome === "error") span?.setStatus({ code: SPAN_STATUS.error });
              span?.end();
            };
          };
        },
      }),
      Provider(OtelSdk)({
        inject: { offered: Instrumentations },
        acquire: ({ offered }) =>
          fromSafePromise(
            Promise.all(offered.map((load) => load())).then((loaded) => {
              const sdk = new NodeSDK({
                ...options,
                instrumentations: [
                  ...(options?.instrumentations ?? []),
                  ...loaded.filter((one): one is SdkInstrumentations[number] => one !== undefined),
                ],
              });
              sdk.start();
              return sdk;
            }),
          ),
        release: (sdk) => sdk.shutdown(),
      }),
      // Depending on the SDK port is what orders these after `start()`, so
      // the global providers the getters read are the configured ones.
      Provider(Tracer)({
        inject: { sdk: OtelSdk },
        sync: () => trace.getTracer("@btravstack/observability"),
      }),
      Provider(Meter)({
        inject: { sdk: OtelSdk },
        sync: () => metrics.getMeter("@btravstack/observability"),
      }),
    ],
    exports: [Tracer, Meter, Observers],
  } as never) as unknown as Module<Tracer | Meter | Observers, never, Scope>;

/** The span a unit rides, ended when the unit's fork closes. */
export class UnitSpan extends Port("UnitSpan")<Span> {}

/**
 * A span per unit, as a module a starter's own `unit` option binds: the runtime
 * forks it around every unit it opens, so the span opens when the fork is built
 * and `onStop` ends it on every path out.
 *
 * The correlation is the ambient record's own, carried as attributes so a span
 * joins the same query the logger's lines answer. Every operation observed
 * inside the unit — a cache read, a stored object, a sent mail — is this
 * span's CHILD and carries the same attributes. The remote PARENT is
 * deliberately not reconstructed: `UnitMeta.traceId` carries the inbound trace
 * id alone, so this correlates by attribute rather than pretending to a W3C
 * parent-child edge it cannot prove.
 *
 * Bind it as a starter's `unit` module — `unit: { anonymous: UnitSpanModule }`,
 * `unit: { message: … }`, `unit: { activity: … }`; the root must export `Tracer`.
 */
export const UnitSpanModule = Module("UnitSpan")({
  needs: [Tracer],
  provides: [
    Provider(UnitSpan)({
      inject: { tracer: Tracer },
      sync: ({ tracer }) => {
        const unit = currentUnit();
        const span = tracer.startSpan("unit");
        span.setAttributes(unitAttributes(unit));
        // Only an OTel span can parent another; a hand-bound `Tracer` that is
        // not OTel's still gets its unit span, just no children.
        if (unit !== undefined && "spanContext" in span) unitSpans.set(unit, span as OtelSpan);
        return span;
      },
      // Teardown runs inside the record, after the work settled: aborted wins,
      // since a unit the kernel stopped waiting for may still have settled ok.
      onStop: (span) => {
        if (currentUnit()?.signal.aborted === true) {
          span.setStatus({ code: SPAN_STATUS.error, message: "aborted" });
        } else if (unitOutcome() === "error") {
          span.setStatus({ code: SPAN_STATUS.error });
        }
        span.end();
      },
    }),
  ],
  exports: [UnitSpan],
});
