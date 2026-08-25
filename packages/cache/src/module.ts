import { Logger, Meter, Tracer } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";

import { Cache, CacheBackend } from "./cache.js";
import { instrument } from "./instrument.js";

export type CacheOptions<E, N, Instrumented extends boolean> = {
  /**
   * The adapter module: `memoryCache()` from this entry point,
   * `redisCache()` from `@btravstack/cache/redis`, or one an application
   * wrote itself over `CacheBackend`.
   */
  readonly adapter: Module<CacheBackend, E, N>;
  /**
   * Span, count and log every call. **Default `true`**, `false` opts out — the
   * way `StartOptions`' `signals` and `probes` do.
   *
   * On by default because telemetry that is missing is discovered during an
   * incident. The cost is stated rather than hidden: instrumenting puts
   * `Logger`, `Meter` and `Tracer` in this module's `Needs`, so a root without
   * `observability()` and `otel()` gets a compile error naming all three.
   */
  readonly instrumented?: Instrumented;
};

/**
 * The cache starter: an adapter, and `Cache` provided from it — instrumented
 * or not, decided here at the composition root.
 *
 * ```ts
 * cache({ adapter: redisCache() });                      // spans, counts, error lines
 * cache({ adapter: redisCache(), instrumented: false }); // just a cache
 * ```
 *
 * **Two ports, because di allows one provider per port per graph**: the port an
 * application depends on must not be the port an adapter provides, or the
 * instrumented form could only be a layer over the plain one. `CacheBackend` is
 * what an adapter targets, `Cache` what an application reads, and this function
 * is the seam — which is also what a spec overrides to swap an adapter.
 *
 * The instrumented form emits, per call: a span carrying the key, one
 * `btravstack.cache.operations` counter whose `outcome` tells a hit from a miss,
 * and an `error` line when the backend could not answer. **Keys ride spans and
 * log lines; values never do.**
 */
export const cache = <E, N, Instrumented extends boolean = true>({
  adapter,
  instrumented,
}: CacheOptions<E, N, Instrumented>): Module<
  Cache,
  E,
  Instrumented extends true ? N | Logger | Meter | Tracer : N
> =>
  // The two arms build different graphs from one signature, so the cast is how
  // a value-level branch reports the type-level one above.
  (instrumented !== false
    ? Module("InstrumentedCache")({
        needs: [Logger, Meter, Tracer],
        imports: [adapter],
        provides: [
          Provider(Cache)(
            { backend: CacheBackend, logger: Logger, tracer: Tracer, meter: Meter },
            {
              sync: ({ backend, logger, tracer, meter }) =>
                instrument(backend, logger, tracer, meter),
            },
          ),
        ],
        exports: [Cache],
      })
    : Module("Cache")({
        imports: [adapter],
        provides: [Provider(Cache)({ backend: CacheBackend }, { sync: ({ backend }) => backend })],
        exports: [Cache],
      })) as unknown as Module<
    Cache,
    E,
    Instrumented extends true ? N | Logger | Meter | Tracer : N
  >;
