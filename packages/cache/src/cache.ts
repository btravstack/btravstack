import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/**
 * What a `get` answers when the key is there.
 *
 * A one-field record rather than the value itself, because a cached `null`
 * and a key nobody set are different facts and `undefined` can only carry
 * one of them.
 */
export type CacheHit = { readonly value: unknown };

/**
 * The adapter could not answer — the connection is down, the server refused
 * the command.
 *
 * It is an operational state rather than a programmer error, so it is
 * modeled: whether an unreachable cache degrades to a miss (the usual
 * answer) or fails the request is the CALLER's decision, and a package that
 * threw it away would be making that decision for every application at once.
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
 * Keys are plain strings and the caller composes them, tenant included
 * (`customers:{tenantId}:{id}`). A cache is an application service, not a
 * domain port: a namespace parameter would put a tenancy model in a package
 * that has no business holding one, and the framework has no concept of a
 * tenant anywhere else either.
 *
 * A value is `unknown` in both directions, encoded by the adapter. Claiming
 * what came back is the caller's, at the boundary where the value re-enters
 * the application's vocabulary — the same once-per-boundary rule a branded
 * id follows.
 */
export class Cache extends Port("Cache")<CacheService> {}

/**
 * The port every adapter provides, and the one an application never depends
 * on.
 *
 * It exists because di allows one provider per port per graph: an
 * instrumented composition cannot layer over a module that already provides
 * `Cache`, so an adapter provides this instead and the composition —
 * `cache()`, with or without its `instrumented` flag, — is what turns it into `Cache`. It is
 * exported because a spec substituting an adapter under the real root
 * overrides this port, which is a name a fixture has to be able to write.
 */
export class CacheBackend extends Port("CacheBackend")<CacheService> {}
