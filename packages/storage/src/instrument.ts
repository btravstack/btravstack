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

type Operation = "put" | "get" | "delete" | "presigned_url";
type Failure = ObjectNotFound | PresignNotSupported | StorageUnavailable;

/**
 * One operation, wrapped: a span around it, a count of how it came out, and a
 * log line if it failed.
 *
 * **A missing object is counted `not_found` and logged at `info`, not
 * `error`.** Asking for something that is not there is an ordinary answer —
 * a caller checking whether a document exists yet meets it on the happy path
 * — and a dashboard that treats it as a fault teaches its readers to ignore
 * the fault line. `StorageUnavailable` is what pages somebody.
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
      const missing =
        failure.tag === "Err" &&
        (failure.error._tag === "ObjectNotFound" || failure.error._tag === "PresignNotSupported");
      const outcome = missing ? "not_found" : "error";
      operations.add(1, { operation, outcome });
      if (missing) {
        logger.info("the object was not there", { operation, key });
      } else {
        logger.error("the store could not answer", { operation, key }, cause);
        span.setStatus({ code: SPAN_STATUS.error });
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
  // does not — the same split `createLogger` documents for the ambient record.
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
  };
};
