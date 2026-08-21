import { Module, Port, Provider } from "@btravstack/di";
import { testRuntime, type TestRuntimeInfo } from "@btravstack/testing";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { RuntimePort, type Runtime, type Serving } from "./runtime.js";
import { start, type RunningApp, type StartGate } from "./start.js";

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
// carries the runtime's `Resolves` and `Info`, and the module exporting it is
// what `start` reads both back from.
class NeedsGreeting extends RuntimePort<Runtime<typeof Greeting, { readonly port: number }>> {}
class NeedsClock extends RuntimePort<Runtime<typeof Clock>> {}

const needsGreeting: Runtime<typeof Greeting, { readonly port: number }> = {
  name: "resolves-greeting",
  resolves: [Greeting],
  start: () => OkAsync({ ...serving, info: { port: 8080 } }),
};

const needsClock: Runtime<typeof Clock> = {
  name: "resolves-clock",
  resolves: [Clock],
  start: () => OkAsync(serving),
};

// The gate is satisfied: the module exports the port the runtime resolves — and
// `Info` is read off the module, not passed in.
const Satisfied = Module("Satisfied")({
  imports: [AppModule],
  provides: [Provider(NeedsGreeting)({ value: needsGreeting })],
  exports: [Greeting, NeedsGreeting],
});
expectTypeOf(start(Satisfied)).toEqualTypeOf<RunningApp<never, { readonly port: number }>>();

// The gate bites: `Unsatisfied` does not export `Clock`, so the marker
// intersected onto `module` is a sentence the argument cannot satisfy — and
// the sentence is what tsc prints as the parameter type it did not match.
const Unsatisfied = Module("Unsatisfied")({
  imports: [AppModule],
  provides: [Provider(NeedsClock)({ value: needsClock })],
  exports: [Greeting, NeedsClock],
});
// @ts-expect-error -- UNSATISFIED RUNTIME PORTS: the runtime resolves `Clock`, which the module does not export
start(Unsatisfied);

// WHICH arm rejected it, pinned: the directive above accepts ANY error, so the
// sentence a reader is actually shown is asserted here or nowhere.
expectTypeOf<
  StartGate<Greeting | NeedsClock>
>().toEqualTypeOf<"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export">();

// The other way the gate bites: a module that exports no runtime port at all.
// @ts-expect-error -- NO RUNTIME: `AppModule` exports no port declared over `RuntimePort`
start(AppModule);
expectTypeOf<
  StartGate<Greeting>
>().toEqualTypeOf<"NO RUNTIME — the module exports no port declared over RuntimePort">();

// A runtime that resolves nothing works against any module: `InstanceType<never>` is
// `never`, and `[never] extends [X]` holds for every `X`. `testRuntime` ships
// its own module, so nothing else needs composing.
expectTypeOf(start(testRuntime().module)).toEqualTypeOf<RunningApp<never, TestRuntimeInfo>>();

// The unit half of the gate, isolated: what the runtime resolves is satisfied, so
// only the unit module's unmet `Clock` can be what rejects the call.
class Span extends Port("GateSpan")<{ readonly note: string }> {}

const ClockyUnit = Module("ClockyUnit")({
  needs: [Clock],
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
expectTypeOf<
  StartGate<Greeting | NeedsGreeting, Clock>
>().toEqualTypeOf<"UNSATISFIED UNIT NEEDS — the unit module needs a port the module does not export">();

// A runtime may NOT resolve a port from the unit module's exports: `Span` exists
// only while a unit is open, and `RuntimeHost.ctx` is the application context
// — so a runtime that names it is rejected here rather than left to `ctx.get`
// throwing at startup.
const GreetingSpanUnit = Module("GreetingSpanUnit")({
  needs: [Greeting],
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
  name: "resolves-span",
  resolves: [Span],
  start: () => OkAsync(serving),
};

const SpanApp = Module("SpanApp")({
  imports: [AppModule],
  provides: [Provider(NeedsSpan)({ value: needsSpan })],
  exports: [Greeting, NeedsSpan],
});
// @ts-expect-error -- UNSATISFIED RUNTIME PORTS: `Span` is a unit-only port, not among `SpanApp`'s exports
start(SpanApp, { unit: GreetingSpanUnit });
