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
 * `presignedUrl` answers `PresignNotSupported` rather than minting a
 * `file://` or a `data:` URL. A fake URL would be the worst kind of test
 * double — one that passes locally and fails in the deployment for a reason
 * the test could never have shown — so the arm exists in the port precisely
 * so an adapter that cannot do this can say so.
 *
 * ponytail: no size limit, so a process storing unbounded objects grows
 * unbounded. The upgrade path is the S3 adapter, which is what a deployment
 * with that problem should be running.
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
