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
   * Span, count and log every call. **Default `true`** — `false` opts out,
   * the way `StartOptions`' `signals` and `probes` do.
   *
   * On by default because telemetry that is missing is discovered during an
   * incident, not before one; a cache that silently counts nothing is the
   * worse failure. The cost is stated rather than hidden: instrumenting puts
   * `Logger`, `Meter` and `Tracer` in this module's `Needs`, so a root that
   * has not composed `observability()` and `otel()` gets a compile error
   * naming all three — never a quiet absence of spans.
   *
   * `false` is the whole opt-out: the graph then installs no observability
   * at all and declares none of the three.
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
 * **Why the provider is a passthrough, and why there are two ports.** di
 * allows one provider per port per graph, so the port an application depends
 * on must not be the port an adapter provides — otherwise the instrumented
 * form could only be a layer over the plain one, which di has no way to
 * express. `CacheBackend` is what an adapter targets, `Cache` is what an
 * application reads, and this function is the seam between them. It is also
 * what a spec overrides to swap an adapter under the real root.
 *
 * **Why `instrumented` can be one boolean.** The three ports it needs are
 * the kernel's — `@btravstack/core` declares `Logger`, `Tracer` and `Meter`
 * — so this package names them without depending on any implementation, and
 * a graph that passes `false` installs no observability at all. That the
 * flag can be this small IS the reason those contracts live in the kernel:
 * passing the ports in would have been one function too, and a longer call
 * at every composition root.
 *
 * **Why not auto-detect them instead**, which would need an optional-provider
 * notion in di: the type would stop telling the truth. Composing without
 * `otel()` would silently produce no spans rather than a compile error, and
 * adding `otel()` for one reason would quietly change this module's
 * behaviour — behaviour by action at a distance, in a container whose whole
 * claim is that wiring is proven before the process exists.
 *
 * What the instrumented form emits, per call: a span named
 * `cache.get` / `cache.set` / `cache.delete` carrying the key; one counter,
 * `btravstack.cache.operations`, with `{ operation, outcome }` where the
 * outcome tells a hit from a miss — the number anyone actually asks a cache
 * for, and one a call count cannot give; and an `error` line when the
 * backend could not answer. **Keys ride spans and log lines; values never
 * do** — a cached value is application data this package cannot read. The
 * wrapper is transparent to the `Result`, the kernel's own `RunUnit` rule
 * one layer down.
 */
export const cache = <E, N, Instrumented extends boolean = true>({
  adapter,
  instrumented,
}: CacheOptions<E, N, Instrumented>): Module<
  Cache,
  E,
  Instrumented extends true ? N | Logger | Meter | Tracer : N
> =>
  // The two arms build different graphs from one signature, so the return
  // type is the conditional above rather than either branch's own — which no
  // inference can produce. The cast is how a value-level branch reports a
  // type-level one.
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
