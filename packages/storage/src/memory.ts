import { Module, Provider } from "@btravstack/di";
import { ErrAsync, OkAsync } from "unthrown";

import {
  ObjectNotFound,
  PresignNotSupported,
  StorageBackend,
  type StorageService,
  type StoredObject,
} from "./storage.js";

/**
 * The in-process adapter: a `Map`, and an honest refusal to presign.
 *
 * `presignedUrl` answers `PresignNotSupported` rather than minting a fake URL,
 * which would be the worst kind of double — one that passes locally and fails in
 * the deployment for a reason no test could have shown.
 *
 * ponytail: no size limit, so a process storing unbounded objects grows
 * unbounded. The upgrade path is the S3 adapter.
 */
export const memoryStorageBackend = (): StorageService => {
  const objects = new Map<string, StoredObject>();

  return {
    put: (key, bytes, options) => {
      objects.set(key, { bytes, contentType: options.contentType });
      return OkAsync();
    },
    get: (key) => {
      const object = objects.get(key);
      return object === undefined ? ErrAsync(new ObjectNotFound({ key })) : OkAsync(object);
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
  Provider(StorageBackend)({}, { sync: () => memoryStorageBackend() });

/** The adapter as a module, which is the shape `storage({ adapter })` takes. */
export const memoryStorage = (): Module<StorageBackend, never, never> =>
  Module("MemoryStorage")({
    provides: [memoryStorageProvider()],
    exports: [StorageBackend],
  });
