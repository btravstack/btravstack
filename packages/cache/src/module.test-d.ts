/**
 * The compile-time half of `cache({ instrumented: true })`: it needs a
 * `Logger`, a `Meter` and a `Tracer`, and a root that composes it without
 * `observability()` and `otel()` carries those three in `Needs` — which
 * `Module.scoped` refuses by its own declared-dependency gate, naming them.
 *
 * The flag is what the whole shape turns on: one function, and the cost of
 * turning it on stated in the type at the composition root. The plain form
 * beside it declares nothing and installs nothing. Type-checked by this
 * package\'s `test:types` script, never executed.
 */
import { Env } from "@btravstack/config";
import { Module, Provider } from "@btravstack/di";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { OkAsync } from "unthrown";

import { Cache } from "./cache.js";
import { memoryCache } from "./memory.js";
import { cache } from "./module.js";

// Positive: with `observability()` and `otel()` composed beside it, nothing
// is left owing and the graph builds.
const Instrumented = Module("Instrumented")({
  imports: [cache({ adapter: memoryCache(), instrumented: true }), observability(), otel()],
  // `observability()` reads `LOG_LEVEL`, which `start` supplies at the root
  // of a real application; here the root is this file.
  provides: [Provider(Env)({ value: {} })],
  exports: [Cache],
});
const _instrumented = Module.scoped(Instrumented, (ctx) => OkAsync(ctx.get(Cache)));

// The same flag with the three ports nowhere in the graph.
const Unobserved = Module("Unobserved")({
  imports: [cache({ adapter: memoryCache(), instrumented: true })],
  exports: [Cache],
});

// Negative: `Logger | Meter | Tracer` are in `Needs`, so the marker on
// `scoped`\'s module parameter is the `UNSATISFIED DEPENDENCIES` sentence and
// the module cannot satisfy it.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides Logger, Meter or Tracer.
const _unobserved = Module.scoped(Unobserved, (ctx) => OkAsync(ctx.get(Cache)));

// The flag off — the default — needs nothing and installs nothing: this is
// the graph an application that wants no observability composes.
const Plain = Module("Plain")({
  imports: [cache({ adapter: memoryCache() })],
  exports: [Cache],
});
const _plain = Module.scoped(Plain, (ctx) => OkAsync(ctx.get(Cache)));

// Written out rather than passed implicitly, because `false` must reach the
// SAME arm as the absent flag: a root that spells its choice does not
// suddenly owe three ports.
const Off = Module("Off")({
  imports: [cache({ adapter: memoryCache(), instrumented: false })],
  exports: [Cache],
});
const _off = Module.scoped(Off, (ctx) => OkAsync(ctx.get(Cache)));

void _instrumented;
void _unobserved;
void _plain;
void _off;
