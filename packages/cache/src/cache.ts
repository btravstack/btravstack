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
   * Answer from the cache, or run `loader` and store what it produced.
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

/** The derivation, applied by `cache()` — an adapter never implements it. */
export const readThrough = (backend: CacheBackendService): CacheService => ({
  ...backend,
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
              backend
                .set(key, value, options)
                .recoverErrCases((matcher) =>
                  matcher.with(P.tag("CacheUnavailable"), () => undefined),
                ),
            )
          : OkAsync(hit.value as T),
      ),
});

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
