import {
  observed,
  type Operation as Observable,
  type Settle,
  type Settled,
} from "@btravstack/core";
import type { AsyncResult, FailureView } from "unthrown";

import type {
  ObjectNotFound,
  PresignNotSupported,
  StorageService,
  StorageUnavailable,
} from "./storage.js";

type Operation = "put" | "get" | "delete" | "presigned_url" | "presigned_upload";
type Failure = ObjectNotFound | PresignNotSupported | StorageUnavailable;

/**
 * **A missing object settles `ok` with `result: "not_found"`, not `error`.**
 * Asking for something that is not there is an ordinary answer, and a dashboard
 * that treats it as a fault teaches its readers to ignore the fault line.
 * `StorageUnavailable` is what pages somebody, and it is the only one that
 * settles as an error. The two ordinary answers keep their own words in
 * `reason`, so an operator is not left hunting an object sitting where they put
 * it.
 */
const failed = <T>(failure: FailureView<Failure, T>): Settled => {
  const cause = failure.tag === "Err" ? failure.error : failure.cause;
  const ordinary =
    failure.tag !== "Err"
      ? undefined
      : failure.error._tag === "ObjectNotFound"
        ? "the object was not there"
        : failure.error._tag === "PresignNotSupported"
          ? "this store cannot mint a url"
          : undefined;
  return ordinary === undefined
    ? { outcome: "error", attributes: { result: "error" }, cause }
    : { outcome: "ok", attributes: { result: "not_found", reason: ordinary } };
};

/** The KEY is a detail, not a dimension: on the span and the line, never on an instrument. */
const through =
  (observers: readonly ((operation: Observable) => Settle)[]) =>
  <T, E extends Failure>(operation: Operation, key: string, call: () => AsyncResult<T, E>) =>
    observed(
      observers,
      {
        component: "storage",
        name: operation,
        attributes: { operation },
        details: { "btravstack.storage.key": key },
      },
      call,
      { ok: () => ({ outcome: "ok", attributes: { result: "ok" } }), failure: failed },
    );

/** Every operation handed to the observers the graph composed, transparent to the `Result`. */
export const instrument = (
  backend: StorageService,
  observers: readonly ((operation: Observable) => Settle)[],
): StorageService => {
  const observe = through(observers);
  return {
    put: (key, bytes, options) => observe("put", key, () => backend.put(key, bytes, options)),
    get: (key) => observe("get", key, () => backend.get(key)),
    delete: (key) => observe("delete", key, () => backend.delete(key)),
    presignedUrl: (key, options) =>
      observe("presigned_url", key, () => backend.presignedUrl(key, options)),
    presignedUpload: (key, options) =>
      observe("presigned_upload", key, () => backend.presignedUpload(key, options)),
  };
};
