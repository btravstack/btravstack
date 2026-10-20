import { Port } from "@btravstack/di";
import { TaggedError, type AsyncResult } from "unthrown";

/** One stored object: its bytes and what they are. */
export type StoredObject = {
  readonly bytes: Uint8Array;
  readonly contentType: string;
};

/**
 * An object read as it streams. `stream` holds the store's connection until it
 * is read to its end or cancelled, so a caller that stops early cancels it. A
 * read the store breaks off errors the stream.
 */
export type StreamedObject = {
  readonly stream: ReadableStream<Uint8Array>;
  readonly contentType: string;
  /** The object's length in bytes; `undefined` when the store did not say, never a guessed `0`. */
  readonly size: number | undefined;
};

/** The key is not there. Only `get`, `getStream`, `head` and `copy` (its source) answer it — see `delete` and `presignedUrl` below. */
export class ObjectNotFound extends TaggedError("ObjectNotFound")<{
  readonly key: string;
}> {}

/** An object already holds the key. Only `putIfAbsent` and `putStreamIfAbsent` answer it. */
export class ObjectExists extends TaggedError("ObjectExists")<{
  readonly key: string;
}> {}

/** Invalid options are refused before any write or signature is attempted. */
export class InvalidStorageOptions extends TaggedError("InvalidStorageOptions")<{
  readonly key: string;
  readonly reason: "invalid_sha256" | "invalid_metadata_key";
}> {}

/** The supplied SHA-256 did not match the body; no object was written. */
export class ChecksumMismatch extends TaggedError("ChecksumMismatch")<{
  readonly key: string;
}> {}

/** The source stream errored before it ended, with `cause`; no object was written. */
export class StreamInterrupted extends TaggedError("StreamInterrupted")<{
  readonly key: string;
  readonly cause: unknown;
}> {}

/** The store could not answer — the endpoint is down, the credentials were refused, the bucket is gone. */
export class StorageUnavailable extends TaggedError("StorageUnavailable")<{
  readonly operation:
    | "put"
    | "putIfAbsent"
    | "putStream"
    | "putStreamIfAbsent"
    | "get"
    | "getStream"
    | "copy"
    | "head"
    | "delete"
    | "presignedUrl"
    | "presignedUpload";
  readonly key: string;
  readonly reason: string;
}> {}

/** The adapter cannot mint a time-limited URL, and says so rather than pretending. */
export class PresignNotSupported extends TaggedError("PresignNotSupported")<{
  readonly key: string;
}> {}

/** What the store knows about an object without sending its bytes. */
export type ObjectHead = {
  readonly size: number;
  /** An owned snapshot of user metadata; empty when none was written. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly contentType: string;
  /** Lowercase hex of a full-object SHA-256; absent when the store holds none. Composite multipart checksums are excluded. */
  readonly sha256?: string;
};

/**
 * Written with `kmsKeyId`, an object is encrypted at rest with that KMS key
 * (SSE-KMS); without it, the store's own default applies.
 */
export type WriteOptions = {
  readonly contentType: string;
  readonly kmsKeyId?: string;
  /** Lowercase, 64-character hex. The store verifies the body before publishing it. */
  readonly sha256?: string;
  /** Lowercase ASCII HTTP-token keys, without `x-amz-meta-`. No normalization; uppercase keys (and thus case collisions) are refused. The caller respects S3's 2 KB UTF-8 key/value limit. */
  readonly metadata?: Readonly<Record<string, string>>;
  readonly checksum?: never;
};

/** A destination description and optional server-computed checksum; no write digest is accepted. */
export type CopyOptions = {
  readonly contentType: string;
  readonly kmsKeyId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly checksum?: "sha256";
  readonly sha256?: never;
};

export type StorageService = {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    options: WriteOptions,
  ) => AsyncResult<void, InvalidStorageOptions | ChecksumMismatch | StorageUnavailable>;
  /** Writes the object only if no object holds the key: the first writer wins, atomically, in the store. */
  readonly putIfAbsent: (
    key: string,
    bytes: Uint8Array,
    options: WriteOptions,
  ) => AsyncResult<
    void,
    ObjectExists | InvalidStorageOptions | ChecksumMismatch | StorageUnavailable
  >;
  /**
   * Writes the object as `stream` delivers it, never holding it whole: the S3
   * adapter sends a stream longer than one 8 MiB part as a multipart upload, one
   * part at a time. S3's 10,000 parts cap such an object near 78 GiB; a longer
   * stream is refused by the store, as `StorageUnavailable`. The object appears only once the stream has ended and every
   * part is stored. A failure (the stream's own error, a `sha256` the bytes do
   * not match, the store) aborts the upload, so no partial object is ever
   * visible, and cancels the stream.
   *
   * `sha256` is verified by the adapter as the bytes pass, before the object
   * is completed; the store keeps no digest, so `head` answers none.
   */
  readonly putStream: (
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: WriteOptions,
  ) => AsyncResult<
    void,
    InvalidStorageOptions | ChecksumMismatch | StreamInterrupted | StorageUnavailable
  >;
  /**
   * `putStream`, completed only if no object holds the key: the first writer
   * wins, atomically, in the store. The S3 adapter sends `If-None-Match: *` on
   * the write that publishes the object, so a held key is refused once the
   * stream has been sent.
   */
  readonly putStreamIfAbsent: (
    key: string,
    stream: ReadableStream<Uint8Array>,
    options: WriteOptions,
  ) => AsyncResult<
    void,
    ObjectExists | InvalidStorageOptions | ChecksumMismatch | StreamInterrupted | StorageUnavailable
  >;
  readonly get: (key: string) => AsyncResult<StoredObject, ObjectNotFound | StorageUnavailable>;
  /** The object as a stream, with its type and size, answered once the store has begun sending it. */
  readonly getStream: (
    key: string,
  ) => AsyncResult<StreamedObject, ObjectNotFound | StorageUnavailable>;
  /**
   * Copies `from` to `to` inside the store: no bytes pass through this process.
   * The copy replaces metadata (empty when omitted) and `contentType`, and, with
   * `kmsKeyId`, is encrypted with that key. An existing `to` is overwritten.
   */
  readonly copy: (
    from: string,
    to: string,
    options: CopyOptions,
  ) => AsyncResult<void, ObjectNotFound | InvalidStorageOptions | StorageUnavailable>;
  /**
   * Size, type and checksum of an object, without reading it. `sha256` is
   * present only if the store holds one: S3 keeps it for an object written with
   * a SHA-256 checksum (write/presign `sha256`, or copy `checksum`), and
   * reports it base64-encoded, which the adapter converts to hex.
   */
  readonly head: (key: string) => AsyncResult<ObjectHead, ObjectNotFound | StorageUnavailable>;
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
  /**
   * A URL that writes the object for `ttlMs`, without the caller holding
   * credentials — so the bytes go from the client to the store and never
   * through this process.
   *
   * **`contentType` and `contentLength` are signed, not advisory.** They are
   * part of the signature, so a client sending different ones is refused by the
   * store. The same URL can write the key repeatedly until expiry, replacing
   * the previous object with different bytes of that size and type. Neither
   * signed header proves the bytes. `contentLength` is required — an unsigned
   * length would allow an unbounded single write, and there is no ceiling a
   * presigned PUT can express other than the exact number.
   *
   * **`sha256` (lowercase hex, 64 characters) is optional.** When given, the
   * checksum header is signed too, so the store refuses any body that does not
   * hash to it, and keeps it for `head`. The client must send the same value as
   * `x-amz-checksum-sha256` (base64 of the digest).
   *
   * With `kmsKeyId`, both `x-amz-server-side-encryption: aws:kms` and
   * `x-amz-server-side-encryption-aws-kms-key-id` are mandatory signed headers.
   * The client sends the exact key id used here. Omitting or changing either
   * breaks the signature. Malformed `sha256` returns `InvalidStorageOptions`.
   *
   * The application still decides every input: whether this caller may write
   * this key, how long the URL lives, and what size it is willing to accept.
   * The adapter computes a signature over that decision and nothing more.
   */
  readonly presignedUpload: (
    key: string,
    options: {
      readonly ttlMs: number;
      readonly contentType: string;
      readonly contentLength: number;
      readonly sha256?: string;
      readonly kmsKeyId?: string;
    },
  ) => AsyncResult<string, PresignNotSupported | InvalidStorageOptions | StorageUnavailable>;
};

/**
 * The port an application depends on.
 *
 * Keys are plain strings the caller composes, tenant included: a store is an
 * application service, and the framework has no concept of a tenant to put in a
 * slot.
 *
 * **Bytes, and streams beside them.** `put` and `get` hold a document whole;
 * `putStream`, `putStreamIfAbsent` and `getStream` move a large object through
 * the process in bounded memory.
 */
export class Storage extends Port("Storage")<StorageService> {}

/** The port every adapter provides, and the one an application never depends on. */
export class StorageBackend extends Port("StorageBackend")<StorageService> {}
