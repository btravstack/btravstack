import {
  SPAN_STATUS,
  type Counter,
  type LoggerService,
  type MeterService,
  type TracerService,
} from "@btravstack/core";
import type { AsyncResult } from "unthrown";

import type { CacheService, CacheUnavailable } from "./cache.js";

type Operation = "get" | "set" | "delete";
type Outcome = "hit" | "miss" | "ok" | "error";

/**
 * One call, wrapped: a span around it, a count of how it came out, and a log
 * line if it failed.
 *
 * The wrapper is transparent to the `Result` — whatever the backend answers
 * is what the caller receives, which is the kernel's own `RunUnit` rule one
 * layer down. What it adds is a record of the call, and it adds the same
 * record whether the answer was a hit, a miss or a failure.
 */
const observed = <T>(
  call: () => AsyncResult<T, CacheUnavailable>,
  outcomeOf: (value: T) => Outcome,
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
): AsyncResult<T, CacheUnavailable> => {
  const span = tracer.startSpan(`cache.${operation}`);
  span.setAttributes({ "btravstack.cache.key": key });

  return (
    call()
      .tap((value) => {
        operations.add(1, { operation, outcome: outcomeOf(value) });
        span.end();
      })
      // `tapFailure` rather than an Err-only tap: a defect is a failed call
      // too — an unserialisable value is the one this package can produce —
      // and a span left open by it would be worse than the defect.
      .tapFailure((failure) => {
        const cause = failure.tag === "Err" ? failure.error : failure.cause;
        operations.add(1, { operation, outcome: "error" });
        logger.error("the cache could not answer", { operation, key }, cause);
        span.setStatus({ code: SPAN_STATUS.error });
        span.end();
      })
  );
};

export const instrument = (
  backend: CacheService,
  logger: LoggerService,
  tracer: TracerService,
  meter: MeterService,
): CacheService => {
  // One counter per scope, read per call: an instrument is built from the
  // meter once, and it is the ATTRIBUTES that vary — the same
  // per-construction / per-call split `createLogger` documents for the
  // ambient record.
  const operations = meter.createCounter("btravstack.cache.operations", {
    description: "Cache operations, by operation and outcome",
  });

  return {
    get: (key) =>
      observed(
        () => backend.get(key),
        (hit) => (hit === undefined ? "miss" : "hit"),
        { operation: "get", key, logger, tracer, operations },
      ),
    set: (key, value, options) =>
      observed(
        () => backend.set(key, value, options),
        () => "ok",
        {
          operation: "set",
          key,
          logger,
          tracer,
          operations,
        },
      ),
    delete: (key) =>
      observed(
        () => backend.delete(key),
        () => "ok",
        {
          operation: "delete",
          key,
          logger,
          tracer,
          operations,
        },
      ),
  };
};
