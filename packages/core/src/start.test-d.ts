import type { Env } from "@btravstack/config";
import { Module, Port, Provider, type Scope } from "@btravstack/di";
import { testRuntime, type TestRuntimeInfo } from "@btravstack/testing";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import { RuntimePort, type Runtime, type Serving } from "./runtime.js";
import { start, type RunningApp, type StartGate } from "./start.js";

class Greeting extends Port("Greeting")<{ readonly text: string }> {}
class Clock extends Port("Clock")<{ readonly now: () => number }> {}

const AppModule = Module("App")({
  provides: [Provider(Greeting)({ inject: {}, value: { text: "hello" } })],
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
  provides: [Provider(NeedsGreeting)({ inject: {}, value: needsGreeting })],
  exports: [Greeting, NeedsGreeting],
});
expectTypeOf(start(Satisfied)).toEqualTypeOf<RunningApp<never, { readonly port: number }>>();

// The gate bites: `Unsatisfied` does not export `Clock`, so the marker
// intersected onto `module` is a sentence the argument cannot satisfy — and
// the sentence is what tsc prints as the parameter type it did not match.
const Unsatisfied = Module("Unsatisfied")({
  imports: [AppModule],
  provides: [Provider(NeedsClock)({ inject: {}, value: needsClock })],
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

// The gate that fires FIRST, and the one a newcomer meets most: a root whose
// own providers read a port nothing in the graph provides. Before it existed,
// this printed `Type 'Clock' is not assignable to type 'Scope'` — an internal
// phantom — or, when the port was missing from `exports` too, the RUNTIME
// PORTS sentence, which diagnoses the second mistake and hides the first.
const Unprovided = Module("Unprovided")({
  needs: [Greeting],
  provides: [
    Provider(NeedsGreeting)({
      inject: { greeting: Greeting },
      value: needsGreeting,
    }),
  ],
  exports: [NeedsGreeting],
});
// @ts-expect-error -- UNSATISFIED DEPENDENCIES: nothing in the graph provides `Greeting`
start(Unprovided);
// Both mistakes are present — `Greeting` is provided by nobody AND missing from
// `exports`, which the runtime resolves — and the FIRST one is what prints.
// The port is named by its ID, not by its type: a starter's own generic port
// expands to hundreds of characters of the caller's schema and truncates
// before the name is reached, where `"Greeting"` never does.
expectTypeOf<StartGate<NeedsGreeting, Greeting>>().toEqualTypeOf<{
  readonly "UNSATISFIED DEPENDENCIES — nothing provides": "Greeting";
}>();

// `Scope` and `Env` are the two the kernel itself discharges, so a module
// needing them is satisfied rather than reported.
expectTypeOf<StartGate<Greeting | NeedsGreeting, Scope | Env>>().toEqualTypeOf<unknown>();

// A runtime that resolves nothing works against any module: `InstanceType<never>` is
// `never`, and `[never] extends [X]` holds for every `X`. `testRuntime` ships
// its own module, so nothing else needs composing.
expectTypeOf(start(testRuntime().module)).toEqualTypeOf<RunningApp<never, TestRuntimeInfo>>();

// A per-unit fork's needs are no longer this gate's concern at all: a `fork`
// module is forked over the application context, so its needs are exactly
// what a starter's own `needs` channel already asks the composition root
// to supply — di's ordinary `UNSATISFIED DEPENDENCIES` gate covers that,
// with no arm of `StartGate` involved.
class Span extends Port("GateSpan")<{ readonly note: string }> {}

// A runtime's `resolves` is checked against the module's own exports only —
// `Span` here is never exported by `SpanApp`, so the runtime naming it is
// rejected the same way `NeedsClock` was above, whether or not `Span` also
// happens to be a port only a unit's own fork would ever build.
class NeedsSpan extends RuntimePort<Runtime<typeof Span>> {}

const needsSpan: Runtime<typeof Span> = {
  name: "resolves-span",
  resolves: [Span],
  start: () => OkAsync(serving),
};

const SpanApp = Module("SpanApp")({
  imports: [AppModule],
  provides: [Provider(NeedsSpan)({ inject: {}, value: needsSpan })],
  exports: [Greeting, NeedsSpan],
});
// @ts-expect-error -- UNSATISFIED RUNTIME PORTS: `Span` is not among `SpanApp`'s exports
start(SpanApp);
