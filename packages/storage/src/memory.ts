import { createHash } from "node:crypto";

import { Module, Provider } from "@btravstack/di";
import { Err, ErrAsync, Ok, OkAsync, P, fromPromise, fromSafePromise } from "unthrown";

import { validateOptions } from "./options.js";
import {
  ChecksumMismatch,
  ObjectExists,
  ObjectNotFound,
  PresignNotSupported,
  StorageBackend,
  StreamInterrupted,
  type StorageService,
  type WriteOptions,
  type StoredObject,
} from "./storage.js";

/**
 * Every byte of the stream, or the stream's own error; a refused option cancels
 * it unread, and a cancel that fails leaves the refusal the answer.
 */
const collect = (key: string, stream: ReadableStream<Uint8Array>, options: WriteOptions) =>
  validateOptions(key, options)
    .toAsync()
    .flatTapErrCases((matcher) =>
      matcher.with(P.tag("InvalidStorageOptions"), () =>
        fromSafePromise(
          stream.cancel().then(
            () => undefined,
            () => undefined,
          ),
        ),
      ),
    )
    .flatMap(() =>
      fromPromise(
        (async () => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of stream) chunks.push(chunk);
          return Buffer.concat(chunks);
        })(),
        (cause) => new StreamInterrupted({ key, cause }),
      ),
    );

/**
 * The in-process adapter: a `Map`, and an honest refusal to presign.
 *
 * `presignedUrl` answers `PresignNotSupported` rather than minting a fake URL,
 * which would be the worst kind of double — one that passes locally and fails in
 * the deployment for a reason no test could have shown.
 *
 * `kmsKeyId` is accepted and ignored: nothing is encrypted at rest here.
 *
 * ponytail: no size limit, so a process storing unbounded objects grows
 * unbounded. The upgrade path is the S3 adapter.
 */
export const memoryStorageBackend = (): StorageService => {
  const objects = new Map<
    string,
    StoredObject & { readonly metadata: Readonly<Record<string, string>> }
  >();
  const verify = (key: string, bytes: Uint8Array, options: WriteOptions) =>
    validateOptions(key, options).flatMap(() =>
      options.sha256 !== undefined &&
      createHash("sha256").update(bytes).digest("hex") !== options.sha256
        ? Err(new ChecksumMismatch({ key }))
        : Ok(),
    );

  const store = (key: string, bytes: Uint8Array, options: WriteOptions): void => {
    objects.set(key, {
      bytes: Uint8Array.from(bytes),
      contentType: options.contentType,
      metadata: { ...options.metadata },
    });
  };
  const put = (key: string, bytes: Uint8Array, options: WriteOptions) =>
    verify(key, bytes, options).map(() => store(key, bytes, options));
  const putIfAbsent = (key: string, bytes: Uint8Array, options: WriteOptions) =>
    verify(key, bytes, options).flatMap(() =>
      objects.has(key) ? Err(new ObjectExists({ key })) : Ok(store(key, bytes, options)),
    );

  return {
    put: (key, bytes, options) => put(key, bytes, options).toAsync(),
    putIfAbsent: (key, bytes, options) => putIfAbsent(key, bytes, options).toAsync(),
    putStream: (key, stream, options) =>
      collect(key, stream, options).flatMap((bytes) => put(key, bytes, options)),
    putStreamIfAbsent: (key, stream, options) =>
      collect(key, stream, options).flatMap((bytes) => putIfAbsent(key, bytes, options)),
    copy: (from, to, options) =>
      validateOptions(to, options)
        .flatMap(() => {
          const object = objects.get(from);
          if (object === undefined) {
            return Err(new ObjectNotFound({ key: from }));
          }
          objects.set(to, {
            bytes: object.bytes.slice(),
            contentType: options.contentType,
            metadata: { ...options.metadata },
          });
          return Ok();
        })
        .toAsync(),
    head: (key) => {
      const object = objects.get(key);
      return object === undefined
        ? ErrAsync(new ObjectNotFound({ key }))
        : OkAsync({
            metadata: { ...object.metadata },
            size: object.bytes.byteLength,
            contentType: object.contentType,
            sha256: createHash("sha256").update(object.bytes).digest("hex"),
          });
    },
    get: (key) => {
      const object = objects.get(key);
      // A snapshot, so a reader mutating or transferring what it got cannot touch the store.
      return object === undefined
        ? ErrAsync(new ObjectNotFound({ key }))
        : OkAsync({ contentType: object.contentType, bytes: object.bytes.slice() });
    },
    getStream: (key) => {
      const object = objects.get(key);
      return object === undefined
        ? ErrAsync(new ObjectNotFound({ key }))
        : OkAsync({
            stream: new Blob([object.bytes.slice()]).stream(),
            contentType: object.contentType,
            size: object.bytes.byteLength,
          });
    },
    delete: (key) => {
      objects.delete(key);
      return OkAsync();
    },
    presignedUrl: (key) => ErrAsync(new PresignNotSupported({ key })),
    presignedUpload: (key) => ErrAsync(new PresignNotSupported({ key })),
  };
};

/** The adapter as a provider, which is the shape `@btravstack/testing`'s `overridden` takes. */
export const memoryStorageProvider = () =>
  Provider(StorageBackend)({ inject: {}, sync: () => memoryStorageBackend() });

/** The adapter as a module, which is the shape `storage({ adapter })` takes. */
export const memoryStorage = (): Module<StorageBackend, never, never> =>
  Module("MemoryStorage")({
    provides: [memoryStorageProvider()],
    exports: [StorageBackend],
  });
