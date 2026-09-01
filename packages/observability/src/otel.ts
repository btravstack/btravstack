import {
  Instrumentations,
  Meter,
  Observers,
  SPAN_STATUS,
  Tracer,
  currentUnit,
  type Counter,
  type Histogram,
  type Span,
} from "@btravstack/core";
import { Module, Port, Provider, type Scope } from "@btravstack/di";
import { metrics, trace } from "@opentelemetry/api";
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
            const span = traced === false ? undefined : tracer.startSpan(`${component}.${name}`);
            // Details ride the SPAN and not the instruments: a cache key or a
            // URL is one more field on a span and one more time series on a
            // metric.
            span?.setAttributes({ ...attributes, ...details });
            const startedAt = performance.now();
            const operations = instrument(counters, component, () =>
              meter.createCounter(`btravstack.${component}.operations`, {
                description: `${component} operations, by operation and outcome`,
              }),
            );
            const duration = instrument(durations, component, () =>
              meter.createHistogram(`btravstack.${component}.duration`, {
                description: `${component} operation duration`,
                unit: "ms",
              }),
            );

            return ({ outcome, attributes: settled }) => {
              const all = { ...attributes, ...settled, outcome };
              operations.add(1, all);
              duration.record(performance.now() - startedAt, all);
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
        sync: () => {
          const tracer = trace.getTracer("@btravstack/observability");
          return { startSpan: (name) => tracer.startSpan(name) };
        },
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
 * A span per kernel unit, as a `StartOptions.unit` module: the kernel forks it
 * per unit and tears it down inside the unit's ambient record, so the span opens
 * when the unit does and `onStop` ends it on every path out.
 *
 * The correlation is the ambient record's own, carried as attributes so a span
 * joins the same query the logger's lines answer. The remote PARENT is
 * deliberately not reconstructed: `UnitMeta.traceId` carries the inbound trace
 * id alone, so this correlates by attribute rather than pretending to a W3C
 * parent-child edge it cannot prove.
 *
 * Compose it as `start`'s `unit`; the root must export `Tracer`.
 */
export const UnitSpanModule = Module("UnitSpan")({
  needs: [Tracer],
  provides: [
    Provider(UnitSpan)({
      inject: { tracer: Tracer },
      sync: ({ tracer }) => {
        const unit = currentUnit();
        const span = tracer.startSpan("unit");
        if (unit !== undefined) {
          span.setAttributes({
            "btravstack.unit_id": unit.unitId,
            "btravstack.trace_id": unit.traceId,
            ...(unit.tenantId === undefined ? {} : { "btravstack.tenant_id": unit.tenantId }),
          });
        }
        return span;
      },
      onStop: (span) => span.end(),
    }),
  ],
  exports: [UnitSpan],
});
