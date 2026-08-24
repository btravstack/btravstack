import { Module, Provider } from "@btravstack/di";

import { Cache, CacheBackend } from "./cache.js";

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
 * The provider is a passthrough — the adapter's own service, unchanged — and
 * the reason it exists is di's one-provider-per-port rule: the port an
 * application depends on must not be the port an adapter provides, or
 * `@btravstack/cache/instrumented` could only be a layer over this module,
 * which di has no way to express. Two compositions over one adapter is the
 * shape that rule leaves, and it is the honest one: instrumentation is a
 * different graph, chosen at the composition root, not a flag.
 *
 * Nothing here knows about observability and nothing installs it — an
 * application composing this pays for no logger, no meter and no tracer.
 */
export const cache = <E, N>({ adapter }: CacheOptions<E, N>): Module<Cache, E, N> =>
  Module("Cache")({
    imports: [adapter],
    provides: [Provider(Cache)({ backend: CacheBackend }, { sync: ({ backend }) => backend })],
    exports: [Cache],
  });
