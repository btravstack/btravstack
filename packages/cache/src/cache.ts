import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

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

export type CacheService = {
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
export class CacheBackend extends Port("CacheBackend")<CacheService> {}
