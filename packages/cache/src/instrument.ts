import { observe, type Operation, type Settle } from "@btravstack/core";
import type { AsyncResult } from "unthrown";

import type { CacheBackendService, CacheUnavailable } from "./cache.js";

type Operation_ = "get" | "set" | "delete";
type Outcome = "hit" | "miss" | "ok" | "error";

/**
 * One call, wrapped: handed to every observer the graph composed, started
 * before the backend is asked and settled when it answers.
 *
 * The wrapper is transparent to the `Result` — whatever the backend answers is
 * what the caller receives, which is the kernel's own `RunUnit` rule one layer
 * down. What it adds is a record of the call, and it adds the same record
 * whether the answer was a hit, a miss or a failure.
 *
 * **Keys ride the attributes; values never do.**
 */
const observed = <T>(
  call: () => AsyncResult<T, CacheUnavailable>,
  outcomeOf: (value: T) => Outcome,
  observers: readonly ((operation: Operation) => Settle)[],
  operation: Operation_,
  key: string,
): AsyncResult<T, CacheUnavailable> => {
  const settle = observe(observers, {
    component: "cache",
    name: operation,
    attributes: { operation },
    // The KEY is a detail, not a dimension: on the span and the error line,
    // never on an instrument, where one time series per key is the bill.
    details: { "btravstack.cache.key": key },
  });

  return (
    call()
      .tap((value) => settle({ outcome: "ok", attributes: { result: outcomeOf(value) } }))
      // `tapFailure` rather than an Err-only tap: a defect is a failed call too
      // — an unserialisable value is the one this package can produce — and an
      // observation left unsettled by it would be worse than the defect.
      .tapFailure((failure) =>
        settle({
          outcome: "error",
          cause: failure.tag === "Err" ? failure.error : failure.cause,
        }),
      )
  );
};

export const instrument = (
  backend: CacheBackendService,
  observers: readonly ((operation: Operation) => Settle)[],
): CacheBackendService => ({
  get: (key) =>
    observed(
      () => backend.get(key),
      (hit) => (hit === undefined ? "miss" : "hit"),
      observers,
      "get",
      key,
    ),
  set: (key, value, options) =>
    observed(
      () => backend.set(key, value, options),
      () => "ok",
      observers,
      "set",
      key,
    ),
  delete: (key) =>
    observed(
      () => backend.delete(key),
      () => "ok",
      observers,
      "delete",
      key,
    ),
});
