import { observe, type Operation as Observable, type Settle } from "@btravstack/core";
import type { AsyncResult } from "unthrown";

import type {
  ObjectNotFound,
  PresignNotSupported,
  StorageService,
  StorageUnavailable,
} from "./storage.js";

type Operation = "put" | "get" | "delete" | "presigned_url" | "presigned_upload";
type Failure = ObjectNotFound | PresignNotSupported | StorageUnavailable;

/**
 * One operation, handed to every observer the graph composed.
 *
 * **A missing object settles `ok` with `result: "not_found"`, not `error`.**
 * Asking for something that is not there is an ordinary answer, and a dashboard
 * that treats it as a fault teaches its readers to ignore the fault line.
 * `StorageUnavailable` is what pages somebody, and it is the only one that
 * settles as an error. The two ordinary answers keep their own words in
 * `reason`, so an operator is not left hunting an object sitting where they put
 * it.
 */
const observed = <T, E extends Failure>(
  call: () => AsyncResult<T, E>,
  observers: readonly ((operation: Observable) => Settle)[],
  operation: Operation,
  key: string,
): AsyncResult<T, E> => {
  const settle = observe(observers, {
    component: "storage",
    name: operation,
    attributes: { operation },
    // The KEY is a detail, not a dimension: on the span and the line, never on
    // an instrument, where one time series per object is the bill.
    details: { "btravstack.storage.key": key },
  });

  return call()
    .tap(() => settle({ outcome: "ok", attributes: { result: "ok" } }))
    .tapFailure((failure) => {
      const cause = failure.tag === "Err" ? failure.error : failure.cause;
      const ordinary =
        failure.tag !== "Err"
          ? undefined
          : failure.error._tag === "ObjectNotFound"
            ? "the object was not there"
            : failure.error._tag === "PresignNotSupported"
              ? "this store cannot mint a url"
              : undefined;

      settle(
        ordinary === undefined
          ? { outcome: "error", attributes: { result: "error" }, cause }
          : { outcome: "ok", attributes: { result: "not_found", reason: ordinary } },
      );
    });
};

export const instrument = (
  backend: StorageService,
  observers: readonly ((operation: Observable) => Settle)[],
): StorageService => ({
  put: (key, bytes, options) =>
    observed(() => backend.put(key, bytes, options), observers, "put", key),
  get: (key) => observed(() => backend.get(key), observers, "get", key),
  delete: (key) => observed(() => backend.delete(key), observers, "delete", key),
  presignedUrl: (key, options) =>
    observed(() => backend.presignedUrl(key, options), observers, "presigned_url", key),
  presignedUpload: (key, options) =>
    observed(() => backend.presignedUpload(key, options), observers, "presigned_upload", key),
});
