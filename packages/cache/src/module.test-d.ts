/**
 * The compile-time half of `instrumented`: the flag defaults to `true`, so a
 * root that composes a cache and no observability fails di's declared-
 * dependency gate naming `Logger`, `Meter` and `Tracer` — never a quiet
 * absence of spans. `false` is the opt-out, and it owes nothing.
 *
 * `false` disabling a default-`true` boolean is `StartOptions`' own shape
 * (`signals`, `probes`), which is why the option keeps a positive name: a
 * negative one would read as a double negative the moment anybody wrote
 * `noInstrument: false`.
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

// Positive: the default instruments, and with `observability()` and `otel()`
// beside it nothing is left owing.
const Instrumented = Module("Instrumented")({
  imports: [cache({ adapter: memoryCache() }), observability(), otel()],
  // `observability()` reads `LOG_LEVEL`, which `start` supplies at the root
  // of a real application; here the root is this file.
  provides: [Provider(Env)({ inject: {}, value: {} })],
  exports: [Cache],
});
const _instrumented = Module.scoped(Instrumented, (ctx) => OkAsync(ctx.get(Cache)));

// The default, with the three ports nowhere in the graph.
const Unobserved = Module("Unobserved")({
  imports: [cache({ adapter: memoryCache() })],
  exports: [Cache],
});

// Negative, and the reason the default is `true`: forgetting the observability
// modules is a compile error naming the ports, not a cache that silently
// counts nothing.
// @ts-expect-error — UNSATISFIED DEPENDENCIES: nothing provides Logger, Meter or Tracer.
const _unobserved = Module.scoped(Unobserved, (ctx) => OkAsync(ctx.get(Cache)));

// The opt-out needs nothing and installs nothing.
const Plain = Module("Plain")({
  imports: [cache({ adapter: memoryCache(), instrumented: false })],
  exports: [Cache],
});
const _plain = Module.scoped(Plain, (ctx) => OkAsync(ctx.get(Cache)));

// Spelling the default out reaches the same arm as leaving it off.
const Explicit = Module("Explicit")({
  imports: [cache({ adapter: memoryCache(), instrumented: true }), observability(), otel()],
  provides: [Provider(Env)({ inject: {}, value: {} })],
  exports: [Cache],
});
const _explicit = Module.scoped(Explicit, (ctx) => OkAsync(ctx.get(Cache)));

// A flag computed at runtime is not a literal, so `Instrumented` infers
// `boolean` and the conditional distributes over both arms — which lands on
// the union that OWES the ports. The safe direction, pinned so it stays that
// way: a graph that might instrument must have provided for it.
declare const decided: boolean;
const Dynamic = Module("Dynamic")({
  imports: [cache({ adapter: memoryCache(), instrumented: decided })],
  exports: [Cache],
});

// @ts-expect-error — UNSATISFIED DEPENDENCIES: a maybe-instrumented cache owes the three ports.
const _dynamic = Module.scoped(Dynamic, (ctx) => OkAsync(ctx.get(Cache)));

void _instrumented;
void _unobserved;
void _plain;
void _explicit;
void _dynamic;
