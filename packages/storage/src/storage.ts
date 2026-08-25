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
   * There is **no `ObjectNotFound` arm**: presigning is a signature
   * computation and asks the store nothing, so a URL for a key that does not
   * exist is minted happily and 404s when it is followed. Pretending
   * otherwise would mean a HEAD per call — a round trip bought for a check
   * the caller usually does not want.
   */
  readonly presignedUrl: (
    key: string,
    options: { readonly ttlMs: number },
  ) => AsyncResult<string, PresignNotSupported | StorageUnavailable>;
};

/**
 * The port an application depends on.
 *
 * Keys are plain strings the caller composes, tenant included
 * (`orders/{tenantId}/{orderId}/confirmation.json`) — the same rule
 * `@btravstack/cache` follows, and for the same reason: a store is an
 * application service, and the framework has no concept of a tenant to put
 * in a slot.
 *
 * **Bytes, not streams.** An object here is a document — an invoice, a
 * confirmation, an export — and `Uint8Array` is what every adapter and every
 * caller already has. Streaming is the honest boundary this port does not
 * cross: it would change every signature, every adapter and every test to
 * serve a case (multi-gigabyte media) that wants a different design
 * anyway, and it is a stated non-goal rather than an oversight.
 */
export class Storage extends Port("Storage")<StorageService> {}

/**
 * The port every adapter provides, and the one an application never depends
 * on. The same split `@btravstack/cache` and `@btravstack/mailer` make.
 */
export class StorageBackend extends Port("StorageBackend")<StorageService> {}
