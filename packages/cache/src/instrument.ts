import { observed, type Operation, type Settle, type Settled } from "@btravstack/core";

import type { CacheBackendService } from "./cache.js";

/**
 * The KEY is a detail, not a dimension: on the span and the error line, never
 * on an instrument, where one time series per key is the bill. Values ride
 * nothing at all.
 */
const operation = (name: "get" | "set" | "delete", key: string): Operation => ({
  component: "cache",
  name,
  attributes: { operation: name },
  details: { "btravstack.cache.key": key },
});

const ok = (result: "hit" | "miss" | "ok"): Settled => ({ outcome: "ok", attributes: { result } });

/** Every call handed to the observers the graph composed, transparent to the `Result`. */
export const instrument = (
  backend: CacheBackendService,
  observers: readonly ((operation: Operation) => Settle)[],
): CacheBackendService => ({
  get: (key) =>
    observed(observers, operation("get", key), () => backend.get(key), {
      ok: (hit) => ok(hit === undefined ? "miss" : "hit"),
    }),
  set: (key, value, options) =>
    observed(observers, operation("set", key), () => backend.set(key, value, options), {
      ok: () => ok("ok"),
    }),
  delete: (key) =>
    observed(observers, operation("delete", key), () => backend.delete(key), {
      ok: () => ok("ok"),
    }),
});
