import { systemClock, type Clock } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";

import { CacheBackend, type CacheHit, type CacheService } from "./cache.js";

export type MemoryCacheOptions = {
  /**
   * What `ttlMs` is measured against. Defaults to the kernel's `systemClock`;
   * a spec passes `createFakeClock()` so an expiry is asserted without a real
   * wait.
   */
  readonly clock?: Clock;
};

type Entry = { readonly value: unknown; readonly expiresAt: number | undefined };

/**
 * The in-memory adapter's service, so a spec can drive it without a graph.
 *
 * Expiry is lazy — checked on read rather than swept on a timer — because a
 * timer would keep the event loop alive, and a kernel whose whole drain story
 * is about a process that can end has no business holding one open for a
 * cache.
 *
 * Nothing is serialised here: the value goes in and comes back out as the
 * same reference. That is a real difference from the Redis adapter, and it is
 * the honest one — a fake that deep-cloned would hide a mutation bug the
 * deployment will have.
 *
 * ponytail: no eviction and no maximum size, so a process caching unbounded
 * keys grows unbounded. The upgrade path is the Redis adapter, which is what
 * a deployment with that problem should be running anyway.
 */
export const memoryCacheBackend = (options: MemoryCacheOptions = {}): CacheService => {
  const clock = options.clock ?? systemClock;
  const entries = new Map<string, Entry>();

  return {
    get: (key) => {
      const entry = entries.get(key);
      if (entry === undefined) return OkAsync(undefined);
      if (entry.expiresAt !== undefined && clock.now() >= entry.expiresAt) {
        entries.delete(key);
        return OkAsync(undefined);
      }
      return OkAsync<CacheHit | undefined>({ value: entry.value });
    },
    set: (key, value, setOptions) => {
      const ttlMs = setOptions?.ttlMs;
      entries.set(key, { value, expiresAt: ttlMs === undefined ? undefined : clock.now() + ttlMs });
      return OkAsync();
    },
    delete: (key) => {
      entries.delete(key);
      return OkAsync();
    },
  };
};

/**
 * The adapter as a provider, which is the shape `@btravstack/testing`'s
 * `overridden` takes: a spec substitutes this for the Redis one under the
 * application's real root, and every sibling provider still constructs.
 */
export const memoryCacheProvider = (options: MemoryCacheOptions = {}) =>
  Provider(CacheBackend)({}, { sync: () => memoryCacheBackend(options) });

/** The adapter as a module, which is the shape `cache({ adapter })` takes. */
export const memoryCache = (options: MemoryCacheOptions = {}): Module<CacheBackend, never, never> =>
  Module("MemoryCache")({
    provides: [memoryCacheProvider(options)],
    exports: [CacheBackend],
  });
