import { Module, Port, Provider } from "@btravstack/di";
import { testRuntime, type TestRuntimeInfo } from "@btravstack/testing";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { RuntimePort, type Runtime, type Serving } from "./runtime.js";
import { start, type RunningApp } from "./start.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}
class Clock extends Port("Clock")<{ readonly now: () => number }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ value: { text: "hello" } })],
  exports: [Greeting],
});

const serving: Serving = {
  drain: () => OkAsync(),
  stop: () => OkAsync(),
};

// A runtime is a service on a port declared over `RuntimePort`; the port
// carries the runtime's `Needs` and `Info`, and the module exporting it is
// what `start` reads both back from.
class NeedsGreeting extends RuntimePort<Runtime<typeof Greeting, { readonly port: number }>> {}
class NeedsClock extends RuntimePort<Runtime<typeof Clock>> {}

const needsGreeting: Runtime<typeof Greeting, { readonly port: number }> = {
  name: "needs-greeting",
  needs: [Greeting],
  start: () => OkAsync({ ...serving, info: { port: 8080 } }),
};

const needsClock: Runtime<typeof Clock> = {
  name: "needs-clock",
  needs: [Clock],
  start: () => OkAsync(serving),
};

// The gate is satisfied: the module exports the port the runtime needs — and
// `Info` is read off the module, not passed in.
const Satisfied = Module("Satisfied")({
  imports: [AppModule],
  provides: [Provider(NeedsGreeting)({ value: needsGreeting })],
  exports: [Greeting, NeedsGreeting],
});
expectTypeOf(start(Satisfied)).toEqualTypeOf<RunningApp<never, { readonly port: number }>>();

// The gate bites: `Unsatisfied` does not export `Clock`, so the phantom rest
// tuple is non-empty and the one-argument call no longer typechecks.
const Unsatisfied = Module("Unsatisfied")({
  imports: [AppModule],
  provides: [Provider(NeedsClock)({ value: needsClock })],
  exports: [Greeting, NeedsClock],
});
// @ts-expect-error -- UNSATISFIED RUNTIME NEEDS: the runtime needs `Clock`, which the module does not export
start(Unsatisfied);

// Documented, deliberate limit (verified, not assumed): a caller who spells the
// phantom arguments out by hand does typecheck. That is the same escape hatch
// di's own UNSATISFIED DEPENDENCIES gate leaves open — it takes a deliberate
// act, and the gate exists to catch the accident, not to be unforgeable.
start(Unsatisfied, {}, "UNSATISFIED RUNTIME NEEDS", new Clock());

// The other way the gate bites: a module that exports no runtime port at all.
// @ts-expect-error -- NO RUNTIME: `AppModule` exports no port declared over `RuntimePort`
start(AppModule);
start(AppModule, {}, "NO RUNTIME", "the module exports no port declared over RuntimePort");

// A needs-free runtime works against any module: `InstanceType<never>` is
// `never`, and `[never] extends [X]` holds for every `X`. `testRuntime` ships
// its own module, so nothing else needs composing.
expectTypeOf(start(testRuntime().module)).toEqualTypeOf<RunningApp<never, TestRuntimeInfo>>();

// The unit half of the gate, isolated: the runtime's needs are satisfied, so
// only the unit module's unmet `Clock` can be what rejects the call.
class Span extends Port("GateSpan")<{ readonly note: string }> {}

const ClockyUnit = Module("ClockyUnit")({
  provides: [
    Provider(Span)(
      { clock: Clock },
      {
        sync: ({ clock }) => ({ note: `${clock.now()}` }),
        onStop: () => {},
      },
    ),
  ],
  exports: [Span],
});

// @ts-expect-error -- UNSATISFIED UNIT NEEDS: the unit module reads `Clock`, which the module does not export
start(Satisfied, { unit: ClockyUnit });

// The same escape hatch as the runtime half, naming the unit error literal —
// which is also what pins WHICH branch of the gate rejected the call above.
start(Satisfied, { unit: ClockyUnit }, "UNSATISFIED UNIT NEEDS", new Clock());

// A runtime may NOT draw a need from the unit module's exports: `Span` exists
// only while a unit is open, and `RuntimeHost.ctx` is the application context
// — so a runtime that names it is rejected here rather than left to `ctx.get`
// throwing at startup.
const GreetingSpanUnit = Module("GreetingSpanUnit")({
  provides: [
    Provider(Span)(
      { greeting: Greeting },
      {
        sync: ({ greeting }) => ({ note: greeting.text }),
        onStop: () => {},
      },
    ),
  ],
  exports: [Span],
});

class NeedsSpan extends RuntimePort<Runtime<typeof Span>> {}

const needsSpan: Runtime<typeof Span> = {
  name: "needs-span",
  needs: [Span],
  start: () => OkAsync(serving),
};

const SpanApp = Module("SpanApp")({
  imports: [AppModule],
  provides: [Provider(NeedsSpan)({ value: needsSpan })],
  exports: [Greeting, NeedsSpan],
});
// @ts-expect-error -- UNSATISFIED RUNTIME NEEDS: `Span` is a unit-only port, not among `SpanApp`'s exports
start(SpanApp, { unit: GreetingSpanUnit });
