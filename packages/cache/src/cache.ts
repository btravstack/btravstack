import { Port } from "@btravstack/di";
import { OkAsync, P, TaggedError, type AsyncResult } from "unthrown";

/**
 * What a `get` answers when the key is there — a one-field record rather than
 * the value, because a cached `null` and a key nobody set are different facts
 * and `undefined` can only carry one of them.
 */
export type CacheHit = { readonly value: unknown };

/**
 * The adapter could not answer. Modeled rather than thrown away, because
 * whether an unreachable cache degrades to a miss or fails the request is the
 * CALLER's decision.
 */
export class CacheUnavailable extends TaggedError("CacheUnavailable")<{
  readonly operation: "get" | "set" | "delete";
  readonly key: string;
}> {}

/** What an adapter implements: the three operations, and nothing derived. */
export type CacheBackendService = {
  /** A miss is `Ok(undefined)`: absence is the cache working, not failing. */
  readonly get: (key: string) => AsyncResult<CacheHit | undefined, CacheUnavailable>;
  /**
   * An adapter reached through `Cache` is handed whole milliseconds or nothing
   * — `readThrough` reads `ttlMs` once for every adapter, so none of them has
   * to decide what a zero, a fraction or a `NaN` means.
   */
  readonly set: (
    key: string,
    value: unknown,
    options?: { readonly ttlMs?: number },
  ) => AsyncResult<void, CacheUnavailable>;
  /** Deleting a key nobody set is `Ok`: delete is idempotent. */
  readonly delete: (key: string) => AsyncResult<void, CacheUnavailable>;
};

/**
 * What an application reads: the adapter's three, plus the read-through every
 * caller was writing by hand.
 */
export type CacheService = CacheBackendService & {
  /**
   * Answer from the cache, or run `loader` and store what it produced. A
   * `ttlMs` that is not at least a whole millisecond means the value is not
   * stored — see `readThrough` — so the loader's answer still reaches the
   * caller.
   *
   * **The degradation policy is decided here, once**: an unavailable cache is a
   * miss, so the loader runs and the caller sees the answer; a failed write is
   * best effort, so the caller sees the value rather than the cache's problem.
   * That is why `CacheUnavailable` is absent from the error channel — what is
   * left is the loader's own `E`.
   *
   * A hit comes back as `T` by cast: the port stores `unknown`, and the caller
   * owning the key's meaning is the same claim it was making at every call site
   * before this method existed — made once, here.
   */
  readonly getOrSet: <T, E>(
    key: string,
    loader: () => AsyncResult<T, E>,
    options?: { readonly ttlMs?: number },
  ) => AsyncResult<T, E>;
};

/**
 * The one reading of `ttlMs`, shared by every adapter: whole milliseconds, and
 * `undefined` for anything that is not at least one of them.
 *
 * **`undefined` here means DO NOT STORE, not store forever** — `set` answers
 * `Ok` and writes nothing, so the next `get` is an ordinary miss. A computed
 * `deadline - now` goes zero or negative the moment the deadline has passed,
 * which is the common way a bad value arrives, and a miss is what every caller
 * already handles. The two alternatives are both worse: storing without expiry
 * turns an arithmetic slip into a leak, and the Redis adapter's own `PX 0`
 * reported a caller's bug as `CacheUnavailable` — an outage class, which is
 * what an operator pages on.
 */
const wholeMs = (ttlMs: number | undefined): number | undefined => {
  if (ttlMs === undefined) return undefined;
  const rounded = Math.round(ttlMs);
  // `isSafeInteger`, not `isFinite`: `1e100` is finite and rounds to itself, and
  // Redis answers an argument error for a `PX` that large — which would report
  // the caller's own arithmetic as `CacheUnavailable`, the outage class this
  // whole rule exists to keep it out of.
  return Number.isSafeInteger(rounded) && rounded >= 1 ? rounded : undefined;
};

/**
 * The derivation, applied by `cache()` — an adapter never implements it.
 *
 * `set` is overridden rather than spread through, because it is the one place
 * both the direct call and `getOrSet`'s write pass through: an adapter is
 * handed a `ttlMs` that has already been read the same way whichever route the
 * caller took.
 */
export const readThrough = (backend: CacheBackendService): CacheService => {
  const set: CacheBackendService["set"] = (key, value, options) => {
    const ttlMs = wholeMs(options?.ttlMs);
    if (options?.ttlMs !== undefined && ttlMs === undefined) return OkAsync();
    return backend.set(key, value, ttlMs === undefined ? undefined : { ttlMs });
  };

  return {
    ...backend,
    set,
    getOrSet: <T, E>(
      key: string,
      loader: () => AsyncResult<T, E>,
      options?: { readonly ttlMs?: number },
    ): AsyncResult<T, E> =>
      backend
        .get(key)
        .recoverErrCases((matcher) => matcher.with(P.tag("CacheUnavailable"), () => undefined))
        .flatMap((hit) =>
          hit === undefined
            ? loader().flatTap((value) =>
                set(key, value, options).recoverErrCases((matcher) =>
                  matcher.with(P.tag("CacheUnavailable"), () => undefined),
                ),
              )
            : OkAsync(hit.value as T),
        ),
  };
};

/**
 * The port an application depends on.
 *
 * Keys are plain strings and the caller composes them, tenant included: a
 * namespace parameter would put a tenancy model in a package with no business
 * holding one. A value is `unknown` in both directions, encoded by the adapter,
 * and claiming what came back is the caller's.
 */
export class Cache extends Port("Cache")<CacheService> {}

/**
 * The port every adapter provides, and the one an application never depends on.
 *
 * di allows one provider per port per graph, so an instrumented composition
 * cannot layer over a module that already provides `Cache`: an adapter provides
 * this instead, and `cache()` is what turns it into `Cache`. Exported because a
 * spec substituting an adapter overrides this port by name.
 */
export class CacheBackend extends Port("CacheBackend")<CacheBackendService> {}
