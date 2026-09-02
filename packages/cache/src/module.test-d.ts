/**
 * The compile-time half of the observation seam, and what replaced a flag.
 *
 * `cache()` owes NOTHING beyond its adapter's own needs: it reads `Observers`
 * and contributes a no-op member of its own, so a root composing no
 * observability compiles and starts. Composing `observability()` and `otel()`
 * beside it is what makes the calls observed — with no second call site to
 * change, which is the whole of the argument against the flag.
 *
 * Type-checked by this package's `test:types` script, never executed.
 */
import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OkAsync } from "unthrown";

import { Cache } from "./cache.js";
import { memoryCache } from "./memory.js";
import { cache } from "./module.js";

// The point of the change: a cache and no observability at all, and nothing is
// owed. Under the flag this was the arm that failed di's gate naming three
// ports, and the only repair was an option nobody should have had to find.
const Unobserved = Module("Unobserved")({
  imports: [cache({ adapter: memoryCache() })],
  exports: [Cache],
});
const _unobserved = Module.scoped(Unobserved, (ctx) => OkAsync(ctx.get(Cache)));

// The same call, observed — one import away, with the cache's own composition
// untouched.
const Observed = Module("Observed")({
  imports: [cache({ adapter: memoryCache() }), observability(), otel()],
  // `observability()` reads `LOG_LEVEL`, which `start` supplies at the root
  // of a real application; here the root is this file.
  provides: [Provider(Env)({ inject: {}, value: {} })],
  exports: [Cache],
});
const _observed = Module.scoped(Observed, (ctx) => OkAsync(ctx.get(Cache)));

// Negative: `instrumented` is gone, not deprecated. A root still passing it is
// a compile error rather than a silently ignored option.
const _flagged = cache({
  adapter: memoryCache(),
  // @ts-expect-error — `instrumented` no longer exists; observation is a set port.
  instrumented: false,
});

void _unobserved;
void _observed;
void _flagged;
