/**
 * The compile-time half of the instrumented composition: it needs a `Logger`,
 * a `Meter` and a `Tracer`, and a root that composes it without
 * `observability()` and `otel()` carries those three in `Needs` — which
 * `Module.scoped` refuses by its own declared-dependency gate, naming them.
 *
 * That is the whole reason instrumentation is a second composition rather
 * than a flag: the cost is stated in the type, at the composition root, and
 * `cache()` beside it pulls in no observability at all. Type-checked by this
 * package's `test:types` script, never executed.
 */
import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OkAsync } from "unthrown";

import { Cache } from "./cache.js";
import { instrumentedCache } from "./instrumented.js";
import { memoryCache } from "./memory.js";
import { cache } from "./module.js";

// Positive: with `observability()` and `otel()` composed beside it, nothing
// is left owing and the graph builds.
const Instrumented = Module("Instrumented")({
  imports: [instrumentedCache({ adapter: memoryCache() }), observability(), otel()],
  // `observability()` reads `LOG_LEVEL`, which `start` supplies at the root
  // of a real application; here the root is this file.
  provides: [Provider(Env)({ value: {} })],
  exports: [Cache],
});
const _instrumented = Module.scoped(Instrumented, (ctx) => OkAsync(ctx.get(Cache)));

// The same graph with the three ports nowhere in it.
const Unobserved = Module("Unobserved")({
  imports: [instrumentedCache({ adapter: memoryCache() })],
  exports: [Cache],
});

// Negative: `Logger | Meter | Tracer` are in `Needs`, so the marker on
// `scoped`'s module parameter is the `UNSATISFIED DEPENDENCIES` sentence and
// the module cannot satisfy it.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides Logger, Meter or Tracer.
const _unobserved = Module.scoped(Unobserved, (ctx) => OkAsync(ctx.get(Cache)));

// The plain composition, for contrast: no observability anywhere, and no
// need for any — this is the graph an application that wants none composes.
const Plain = Module("Plain")({
  imports: [cache({ adapter: memoryCache() })],
  exports: [Cache],
});
const _plain = Module.scoped(Plain, (ctx) => OkAsync(ctx.get(Cache)));

void _instrumented;
void _unobserved;
void _plain;
