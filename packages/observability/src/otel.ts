import { Meter, Tracer, currentUnit, type Span } from "@btravstack/core";
import { Module, Port, Provider, type Scope } from "@btravstack/di";
import { metrics, trace } from "@opentelemetry/api";
import { NodeSDK, type NodeSDKConfiguration } from "@opentelemetry/sdk-node";
import { Ok } from "unthrown";

/**
 * The tracing half of observability (issue #64) — the **adapter**, not the
 * contract. `Tracer` and `Meter` are the kernel's ports; this file is one
 * implementation of them, and OTel's presence stops at this subpath.
 *
 * `@opentelemetry/*` is an **optional** peer behind it, exactly like `pino`:
 * install the two packages, import `@btravstack/observability/otel`, compose
 * `otel()` — a consumer that never imports this file never needs them, and a
 * package that merely depends on `Tracer` never needed them at all.
 *
 * The ports' contracts are narrowings of OTel's own shapes, so what the SDK
 * hands back satisfies them with no translation in between: `metrics.getMeter()`
 * IS a `MeterService`, and a real span IS a `Span`.
 */

/**
 * The SDK itself, module-private: nothing should resolve it — providing it is
 * what starts it, and `release` is what flushes it. It rides the graph as a
 * RESOURCE so the kernel closes it on every exit path: a span lost in
 * `shutdown()` becomes a `teardownError` and exit `2`, never silence — the
 * flush-on-shutdown half most OTel integrations get wrong, answered by a
 * primitive the kernel already had.
 */
class OtelSdk extends Port("OtelSdk")<NodeSDK> {}

/**
 * The OTel starter: a module providing `Tracer` and `Meter` over a `NodeSDK`
 * opened with the scope and flushed on close. Compose it beside
 * `observability()` in a root's `imports`.
 *
 * **No config slice, deliberately**: the SDK reads the `OTEL_*` environment
 * conventions itself (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`,
 * `OTEL_SDK_DISABLED`, …) — that vocabulary is the platform's own standard,
 * and re-binding it through a `Config` slice would be a second spelling of
 * names operators already know. Programmatic overrides go through `options`,
 * which is the SDK's own configuration type.
 *
 * **Auto-instrumentation cannot live here** and is not attempted:
 * `@opentelemetry/auto-instrumentations-node/register` must be preloaded
 * (`node --import`) before the instrumented libraries are imported, which no
 * DI provider can promise. This module owns what the graph owns — the SDK's
 * lifecycle and the two ports; preloading is the deployment's line.
 */
export const otel = (
  options?: Partial<NodeSDKConfiguration>,
): Module<Tracer | Meter, never, Scope> =>
  Module("Otel")({
    provides: [
      Provider(OtelSdk)({
        acquire: () => {
          const sdk = new NodeSDK(options);
          sdk.start();
          return Ok(sdk);
        },
        release: (sdk) => sdk.shutdown(),
      }),
      // Depending on the SDK port is what orders these after `start()`, so
      // the global providers the getters read are the configured ones.
      Provider(Tracer)(
        { sdk: OtelSdk },
        {
          sync: () => {
            const tracer = trace.getTracer("@btravstack/observability");
            return { startSpan: (name) => tracer.startSpan(name) };
          },
        },
      ),
      Provider(Meter)(
        { sdk: OtelSdk },
        { sync: () => metrics.getMeter("@btravstack/observability") },
      ),
    ],
    exports: [Tracer, Meter],
  });

/** The span a unit rides, ended when the unit's fork closes. */
export class UnitSpan extends Port("UnitSpan")<Span> {}

/**
 * A span per kernel unit, as a `StartOptions.unit` module: the kernel forks
 * this per unit and tears it down inside the unit's ambient record, so the
 * span opens when the unit does and `onStop` ends it on every path out —
 * no kernel change involved, which is the shape the deferred design promised.
 *
 * The correlation is the ambient record's own: `unitId`, `traceId` and (when
 * present) `tenantId` ride as attributes, so a span joins the same query the
 * logger's lines answer — the one id family, on every signal. The remote
 * PARENT is deliberately not reconstructed: `UnitMeta.traceId` carries the
 * inbound trace id alone (never the caller's span id), so v1 correlates by
 * attribute rather than pretending to a W3C parent-child edge it cannot
 * prove.
 *
 * Compose it as `start`'s `unit` (or import it from your own unit module);
 * `needs: [Tracer]` is the fork seam — the root must export `Tracer`, which
 * `otel()` provides.
 */
export const UnitSpanModule = Module("UnitSpan")({
  needs: [Tracer],
  provides: [
    Provider(UnitSpan)(
      { tracer: Tracer },
      {
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
      },
    ),
  ],
  exports: [UnitSpan],
});
