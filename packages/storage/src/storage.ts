import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/** One stored object: its bytes and what they are. */
export type StoredObject = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
};

/** The key is not there. Only `get` answers it — see `delete` and `presignedUrl` below. */
export class ObjectNotFound extends TaggedError("ObjectNotFound")<{
  readonly key: string;
}> {}

/** The store could not answer — the endpoint is down, the credentials were refused, the bucket is gone. */
export class StorageUnavailable extends TaggedError("StorageUnavailable")<{
  readonly operation: "put" | "get" | "delete" | "presignedUrl";
  readonly key: string;
  readonly reason: string;
}> {}

/** The adapter cannot mint a time-limited URL, and says so rather than pretending. */
export class PresignNotSupported extends TaggedError("PresignNotSupported")<{
  readonly key: string;
}> {}

export type StorageService = {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    options: { readonly contentType: string },
  ) => AsyncResult<void, StorageUnavailable>;
  readonly get: (key: string) => AsyncResult<StoredObject, ObjectNotFound | StorageUnavailable>;
  /** Deleting a key nobody stored is `Ok`: delete is idempotent, which is S3's own behaviour rather than a fiction over it. */
  readonly delete: (key: string) => AsyncResult<void, StorageUnavailable>;
  /**
   * A URL that reads the object for `ttlMs`, without the caller holding
   * credentials.
   *
   * There is **no `ObjectNotFound` arm**: presigning is a signature computation
   * that asks the store nothing, so a URL for an absent key is minted happily
   * and 404s when followed. Checking would cost a HEAD per call.
   */
  readonly presignedUrl: (
    key: string,
    options: { readonly ttlMs: number },
  ) => AsyncResult<string, PresignNotSupported | StorageUnavailable>;
};

/**
 * The port an application depends on.
 *
 * Keys are plain strings the caller composes, tenant included: a store is an
 * application service, and the framework has no concept of a tenant to put in a
 * slot.
 *
 * **Bytes, not streams.** An object here is a document. Streaming would change
 * every signature, adapter and test to serve a case that wants a different
 * design anyway — a stated non-goal, not an oversight.
 */
export class Storage extends Port("Storage")<StorageService> {}

/** The port every adapter provides, and the one an application never depends on. */
export class StorageBackend extends Port("StorageBackend")<StorageService> {}
