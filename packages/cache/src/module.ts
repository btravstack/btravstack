import { HealthCheckFailed, HealthChecks, Observers, noObserver } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { P } from "unthrown";

import { Cache, CacheBackend } from "./cache.js";
import { instrument } from "./instrument.js";

export type CacheOptions<E, N> = {
  /**
   * The adapter module: `memoryCache()` from this entry point,
   * `redisCache()` from `@btravstack/cache/redis`, or one an application
   * wrote itself over `CacheBackend`.
   */
  readonly adapter: Module<CacheBackend, E, N>;
};

/**
 * The cache starter: an adapter, and `Cache` provided from it.
 *
 * ```ts
 * cache({ adapter: redisCache() });
 * ```
 *
 * **Two ports, because di allows one provider per port per graph**: the port an
 * application depends on must not be the port an adapter provides, or the
 * observed form could only be a layer over the plain one. `CacheBackend` is
 * what an adapter targets, `Cache` what an application reads, and this function
 * is the seam — which is also what a spec overrides to swap an adapter.
 *
 * **There is no `instrumented` flag, and that is the point.** Every call is
 * handed to whatever contributed to `Observers`; a graph that composed no
 * observability has only this module's own no-op member, so it costs a call per
 * operation and nothing else. What the observers do with it — a span carrying
 * the key, a count whose `result` tells a hit from a miss, an error line —
 * belongs to `@btravstack/observability` rather than here. **Keys ride the
 * attributes; values never do.**
 */
export const cache = <E, N>({
  adapter,
}: CacheOptions<E, N>): Module<Cache | HealthChecks, E, N> => {
  const healthCheck = Provider.member(HealthChecks)({
    inject: { backend: CacheBackend },
    sync: ({ backend }) => ({
      name: "cache",
      // A miss is the cache WORKING — the probe key is never written,
      // so `Ok(undefined)` is the healthy answer and the only
      // unhealthy one is the adapter saying it could not reach the
      // server at all.
      check: () =>
        backend
          .get("btravstack:health")
          .map(() => undefined)
          .mapErrCases((matcher) =>
            matcher.with(
              P.tag("CacheUnavailable"),
              ({ key }) => new HealthCheckFailed({ reason: `cache unavailable (${key})` }),
            ),
          ),
    }),
  });

  // The two arms build different graphs from one signature, so the cast is how
  // a value-level branch reports the type-level one above.
  return Module("Cache")({
    imports: [adapter],
    provides: [
      // The no-op member, so the set this module reads is never the empty
      // dependency di refuses: a graph composing no observability still starts.
      Provider.member(Observers)({ inject: {}, value: noObserver }),
      Provider(Cache)({
        inject: { backend: CacheBackend, observers: Observers },
        sync: ({ backend, observers }) => instrument(backend, observers),
      }),
      healthCheck,
    ],
    exports: [Cache, HealthChecks],
  } as never) as unknown as Module<Cache | HealthChecks, E, N>;
};
