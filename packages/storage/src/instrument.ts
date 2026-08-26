import {
  SPAN_STATUS,
  type Counter,
  type LoggerService,
  type MeterService,
  type Span,
  type TracerService,
} from "@btravstack/core";
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
 * One operation, wrapped: a span around it, a count of how it came out, and a
 * log line if it failed.
 *
 * **A missing object is counted `not_found` and logged at `info`, not
 * `error`.** Asking for something that is not there is an ordinary answer, and
 * a dashboard that treats it as a fault teaches its readers to ignore the fault
 * line. `StorageUnavailable` is what pages somebody.
 */
const observed = <T, E extends Failure>(
  call: () => AsyncResult<T, E>,
  {
    operation,
    key,
    logger,
    tracer,
    operations,
  }: {
    readonly operation: Operation;
    readonly key: string;
    readonly logger: LoggerService;
    readonly tracer: TracerService;
    readonly operations: Counter;
  },
): AsyncResult<T, E> => {
  const span: Span = tracer.startSpan(`storage.${operation}`);
  span.setAttributes({ "btravstack.storage.key": key });

  return call()
    .tap(() => {
      operations.add(1, { operation, outcome: "ok" });
      span.end();
    })
    .tapFailure((failure) => {
      const cause = failure.tag === "Err" ? failure.error : failure.cause;
      // Two non-faults, two lines: one message for both would have an operator
      // hunting an object sitting right where they put it. They share the
      // `not_found` OUTCOME, because a counter separates ordinary from faulty.
      const message =
        failure.tag !== "Err"
          ? undefined
          : failure.error._tag === "ObjectNotFound"
            ? "the object was not there"
            : failure.error._tag === "PresignNotSupported"
              ? "this store cannot mint a url"
              : undefined;

      operations.add(1, { operation, outcome: message === undefined ? "error" : "not_found" });
      if (message === undefined) {
        logger.error("the store could not answer", { operation, key }, cause);
        span.setStatus({ code: SPAN_STATUS.error });
      } else {
        logger.info(message, { operation, key });
      }
      span.end();
    });
};

export const instrument = (
  backend: StorageService,
  logger: LoggerService,
  tracer: TracerService,
  meter: MeterService,
): StorageService => {
  // One instrument per scope, read per call: the attributes vary, the counter
  // does not.
  const operations = meter.createCounter("btravstack.storage.operations", {
    description: "Storage operations, by operation and outcome",
  });

  const context = (operation: Operation, key: string) => ({
    operation,
    key,
    logger,
    tracer,
    operations,
  });

  return {
    put: (key, bytes, options) =>
      observed(() => backend.put(key, bytes, options), context("put", key)),
    get: (key) => observed(() => backend.get(key), context("get", key)),
    delete: (key) => observed(() => backend.delete(key), context("delete", key)),
    presignedUrl: (key, options) =>
      observed(() => backend.presignedUrl(key, options), context("presigned_url", key)),
    presignedUpload: (key, options) =>
      observed(() => backend.presignedUpload(key, options), context("presigned_upload", key)),
  };
};
