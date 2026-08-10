/**
 * The compile-time half of the runtime: `start`'s phantom rest-tuple gate,
 * which relates a runtime's declared `needs` to the module's exports. Every
 * runtime in the kernel's own suite is `Runtime<never>`, so this is the first
 * place the gate is exercised with a non-empty `Needs`. Type-checked by this
 * package's `test:types` script, never executed.
 */
import { Module, Port, Provider } from "@btravstack/di";
import { start } from "@btravstack/start";

import { AppModule } from "./app.js";
import { httpRuntime } from "./http-runtime.js";

// Positive: `AppModule` exports `Router`, which `httpRuntime` needs, so the
// gate resolves to the empty tuple and this is an ordinary two-argument call.
const _ok = start(AppModule, {
  runtime: httpRuntime({ port: 0 }),
  probes: false,
  signals: false,
});

class Unrelated extends Port("Unrelated")<{ readonly n: number }> {}

const Bare = Module("Bare")({
  provides: [Provider(Unrelated)({ value: { n: 1 } })],
  exports: [Unrelated],
});

// Negative: `Bare` does not export `Router`, so the gate becomes a two-element
// required tuple and the call is an arity error naming the unsatisfied need.
// @ts-expect-error — UNSATISFIED RUNTIME NEEDS: Bare does not export Router.
const _bad = start(Bare, {
  runtime: httpRuntime({ port: 0 }),
  probes: false,
  signals: false,
});
