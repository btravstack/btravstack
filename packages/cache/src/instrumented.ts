import { Module, Provider } from "@btravstack/di";
import { Logger, type LoggerService } from "@btravstack/observability";
import { Meter, Tracer } from "@btravstack/observability/otel";
import type { Meter as OtelMeter, Span } from "@opentelemetry/api";
import { SpanStatusCode } from "@opentelemetry/api";
import type { AsyncResult } from "unthrown";

import { Cache, CacheBackend, type CacheService, type CacheUnavailable } from "./cache.js";
import type { CacheOptions } from "./module.js";

type Operation = "get" | "set" | "delete";
type Outcome = "hit" | "miss" | "ok" | "error";

type TracerService = { readonly startSpan: (name: string) => Span };
type Counter = ReturnType<OtelMeter["createCounter"]>;

/**
 * One call, wrapped: a span around it, a count of how it came out, and a log
 * line if it failed.
 *
 * The wrapper is transparent to the `Result` — whatever the backend answers
 * is what the caller receives, which is the kernel's own `RunUnit` rule one
 * layer down. What it adds is a record of the call, and it adds the same
 * record whether the answer was a hit, a miss or a failure.
 */
const observed = <T>(
  call: () => AsyncResult<T, CacheUnavailable>,
  outcomeOf: (value: T) => Outcome,
  {
    operation,
    key,
    logger,
    tracer,
    operations,
  }: {
    readonly operation: Operation;
    readonly key: string;
    readonly logger: LoggerService;
    readonly tracer: TracerService;
    readonly operations: Counter;
  },
): AsyncResult<T, CacheUnavailable> => {
  const span = tracer.startSpan(`cache.${operation}`);
  span.setAttributes({ "btravstack.cache.key": key });

  return (
    call()
      .tap((value) => {
        operations.add(1, { operation, outcome: outcomeOf(value) });
        span.end();
      })
      // `tapFailure` rather than an Err-only tap: a defect is a failed call
      // too — an unserialisable value is the one this package can produce —
      // and a span left open by it would be worse than the defect.
      .tapFailure((failure) => {
        const cause = failure.tag === "Err" ? failure.error : failure.cause;
        operations.add(1, { operation, outcome: "error" });
        logger.error("the cache could not answer", { operation, key }, cause);
        span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      })
  );
};

const instrument = (
  backend: CacheService,
  logger: LoggerService,
  tracer: TracerService,
  meter: OtelMeter,
): CacheService => {
  // One counter per scope, read per call: an instrument is built from the
  // meter once, and it is the ATTRIBUTES that vary — the same
  // per-construction / per-call split `createLogger` documents for the
  // ambient record.
  const operations = meter.createCounter("btravstack.cache.operations", {
    description: "Cache operations, by operation and outcome",
  });

  return {
    get: (key) =>
      observed(
        () => backend.get(key),
        (hit) => (hit === undefined ? "miss" : "hit"),
        { operation: "get", key, logger, tracer, operations },
      ),
    set: (key, value, options) =>
      observed(
        () => backend.set(key, value, options),
        () => "ok",
        {
          operation: "set",
          key,
          logger,
          tracer,
          operations,
        },
      ),
    delete: (key) =>
      observed(
        () => backend.delete(key),
        () => "ok",
        {
          operation: "delete",
          key,
          logger,
          tracer,
          operations,
        },
      ),
  };
};

/**
 * `cache()`, with every call spanned, counted and — when it fails — logged.
 *
 * A span named `cache.get` / `cache.set` / `cache.delete` carries the key;
 * one counter, `btravstack.cache.operations`, carries `{ operation, outcome }`
 * with the outcome telling a hit from a miss, which is the number anyone
 * actually asks a cache for. Keys ride spans and log lines; **values never
 * do** — a cached value is application data and this package has no way to
 * know what is in it.
 *
 * It declares `needs: [Logger, Meter, Tracer]`, so a root composing it
 * without `observability()` and `otel()` fails `start`'s gate, named and
 * typed, rather than at the first read. That is the whole reason
 * instrumentation is a second composition rather than a flag on the first:
 * the cost is visible at the composition root, and the plain `cache()` pulls
 * in no observability at all.
 */
export const instrumentedCache = <E, N>({ adapter }: CacheOptions<E, N>) =>
  Module("InstrumentedCache")({
    needs: [Logger, Meter, Tracer],
    imports: [adapter],
    provides: [
      Provider(Cache)(
        { backend: CacheBackend, logger: Logger, tracer: Tracer, meter: Meter },
        {
          sync: ({ backend, logger, tracer, meter }) => instrument(backend, logger, tracer, meter),
        },
      ),
    ],
    exports: [Cache],
  });
