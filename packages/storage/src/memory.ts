import { createHash } from "node:crypto";

import { Module, Provider } from "@btravstack/di";
import { Err, ErrAsync, Ok, OkAsync } from "unthrown";

import { validateOptions } from "./options.js";
import {
  ChecksumMismatch,
  ObjectExists,
  ObjectNotFound,
  PresignNotSupported,
  StorageBackend,
  type StorageService,
  type WriteOptions,
  type StoredObject,
} from "./storage.js";

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

  return {
    put: (key, bytes, options) =>
      verify(key, bytes, options)
        .map(() => {
          objects.set(key, {
            bytes: Uint8Array.from(bytes),
            contentType: options.contentType,
            metadata: { ...options.metadata },
          });
        })
        .toAsync(),
    putIfAbsent: (key, bytes, options) =>
      verify(key, bytes, options)
        .flatMap(() => {
          if (objects.has(key)) {
            return Err(new ObjectExists({ key }));
          }
          objects.set(key, {
            bytes: Uint8Array.from(bytes),
            contentType: options.contentType,
            metadata: { ...options.metadata },
          });
          return Ok();
        })
        .toAsync(),
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
