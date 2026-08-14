import { Module, Port, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";
import { expectTypeOf } from "vitest";

import type { Runtime, Serving } from "./runtime.js";
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

const needsGreeting: Runtime<typeof Greeting> = {
  name: "needs-greeting",
  needs: [Greeting],
  start: () => OkAsync(serving),
};

const needsClock: Runtime<typeof Clock> = {
  name: "needs-clock",
  needs: [Clock],
  start: () => OkAsync(serving),
};

// The gate is satisfied: the module exports the port the runtime needs.
const satisfied = start(AppModule, { runtime: needsGreeting });
expectTypeOf(satisfied).toEqualTypeOf<RunningApp<never>>();

// The gate bites: `AppModule` does not export `Clock`, so the phantom rest
// tuple is non-empty and the two-argument call no longer typechecks.
// @ts-expect-error -- UNSATISFIED RUNTIME NEEDS: the runtime needs `Clock`, which the module does not export
start(AppModule, { runtime: needsClock });

// Documented, deliberate limit (verified, not assumed): a caller who spells the
// phantom arguments out by hand does typecheck. That is the same escape hatch
// di's own UNSATISFIED DEPENDENCIES gate leaves open — it takes a deliberate
// act, and the gate exists to catch the accident, not to be unforgeable.
start(AppModule, { runtime: needsClock }, "UNSATISFIED RUNTIME NEEDS", new Clock());

// A needs-free runtime works against any module: `InstanceType<never>` is
// `never`, and `[never] extends [X]` holds for every `X`.
const needsNothing: Runtime<never> = {
  name: "needs-nothing",
  needs: [],
  start: () => OkAsync(serving),
};
expectTypeOf(start(AppModule, { runtime: needsNothing })).toEqualTypeOf<RunningApp<never>>();

// The unit half of the gate, isolated: the runtime's needs are satisfied, so
// only the unit module's unmet `Clock` can be what rejects the call.
class Span extends Port("GateSpan")<{ readonly note: string }> {}

const ClockyUnit = Module("ClockyUnit")({
  provides: [
    Provider(Span)([Clock], {
      sync: (clock) => ({ note: `${clock.now()}` }),
      onStop: () => {},
    }),
  ],
  exports: [Span],
});

// @ts-expect-error -- UNSATISFIED UNIT NEEDS: the unit module reads `Clock`, which the module does not export
start(AppModule, { runtime: needsGreeting, unit: ClockyUnit });

// The same escape hatch as the runtime half, naming the unit error literal —
// which is also what pins WHICH branch of the gate rejected the call above.
start(
  AppModule,
  { runtime: needsGreeting, unit: ClockyUnit },
  "UNSATISFIED UNIT NEEDS",
  new Clock(),
);

// A runtime may draw a need from the unit module's exports: `Span` is nowhere
// in `AppModule`, and the fork is what puts it in front of unit work — so
// with a unit module whose own needs the module covers, the gate collapses to
// an ordinary two-argument call.
const GreetingSpanUnit = Module("GreetingSpanUnit")({
  provides: [
    Provider(Span)([Greeting], {
      sync: (greeting) => ({ note: greeting.text }),
      onStop: () => {},
    }),
  ],
  exports: [Span],
});

const needsSpan: Runtime<typeof Span> = {
  name: "needs-span",
  needs: [Span],
  start: () => OkAsync(serving),
};
expectTypeOf(start(AppModule, { runtime: needsSpan, unit: GreetingSpanUnit })).toEqualTypeOf<
  RunningApp<never>
>();
