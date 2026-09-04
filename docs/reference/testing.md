---
title: "@btravstack/testing"
description: The @btravstack/testing surface — bootFixture and Boot, tapped, testRuntime and TestRuntimePort, createFakeClock — with every member's signature and semantics.
---

<!-- doctest: prelude
import type { Env } from "@btravstack/config";
import type { AnyPort, Module } from "@btravstack/di";
import type { RunningApp, RuntimeInfoOf, StartGate, StartOptions } from "@btravstack/core";
import type {
  Boot,
  BootDefaults,
  FakeClock,
  SubmittedUnit,
  TestRuntime,
  TestRuntimeInfo,
  TestRuntimeOptions,
} from "@btravstack/testing";
import { TestRuntimePort } from "@btravstack/testing";
import type { Clock, Runtime, RuntimeHost, Serving } from "@btravstack/core";
import type { AsyncResult } from "unthrown";
-->

# `@btravstack/testing`

> **Reference.** Everything `@btravstack/testing` exports: a vitest fixture
> that boots and stops applications, a tap into a booted graph, a harness that
> starts and stops around a callback, an in-memory runtime and a clock that
> moves on demand. For the recipes, see
> [Test an application](/how-to/test-an-application); for the option each
> plugs into, see [start and StartOptions](/reference/core/start); for why it
> is a package, see [Design decisions](/explanation/design-decisions#the-test-harness-is-a-package).

`@btravstack/testing` is the test harness for the applications
`@btravstack/core` boots — a package of its own, the way `@nestjs/testing`
is, so a production bundle never pulls a fake in and the kernel keeps no test
double of its own. It is a **dev dependency**, and it peers on what it drives:

```sh
pnpm add -D @btravstack/testing
# peers, which an application already holds:
#   @btravstack/core @btravstack/config @btravstack/di unthrown
```

It has **no `vitest` peer**: `bootFixture` returns a plain
`(ctx, use) => Promise<void>` function — vitest's fixture protocol, met
without importing vitest — so the package types against nothing but the
kernel and its peers, and a runner with the same `use` shape can consume it.

## `bootFixture(defaults?)`

<!-- doctest: signature=@btravstack/testing -->

```ts
const bootFixture: (
  defaults?: BootDefaults,
) => (ctx: object, use: (boot: Boot) => Promise<void>) => Promise<void>;

type Boot = <X, E, N>(
  module: Module<X, E, N> & StartGate<X, N>,
  options?: Omit<StartOptions, "signals">,
) => RunningApp<E, RuntimeInfoOf<X>>;

type BootDefaults = Omit<StartOptions, "signals">;
```

A `test.extend` fixture that hands the test a `Boot` — `start`, with the
same signature and the same
[phantom marker on `module`](/reference/core/start#the-gate-startgate-x-n),
minus `signals` — and **stops every
application it started once the test is over**, on every exit path, a
failing assertion included. Wire it once, in the fixture module every spec
imports:

```ts
import { bootFixture, type Boot } from "@btravstack/testing";
import { test } from "vitest";

export const it = test.extend<{ boot: Boot }>({
  boot: bootFixture({ env: { PORT: "0", HOST: "127.0.0.1" } }),
});
```

Every `boot(module, options?)` starts with a test's defaults; `defaults`
overrides them for the whole fixture, and a call's own `options` win over
both.

| Option            | Default under `boot` | Why                                                                                                      |
| ----------------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| `signals`         | `false`, **always**  | Process-wide signal handlers would fight across a file. Not overridable — it is not in `Boot`'s options. |
| `probes`          | `false`              | A probe port would collide between tests. A call passing `{ port: 0 }` gets an ephemeral one.            |
| `preDrainDelayMs` | `0`                  | A test has no Kubernetes endpoint to wait for.                                                           |
| `onEvent`         | `() => {}`           | Silent; a call or `defaults` may pass a sink to hear the lifecycle.                                      |
| everything else   | `start`'s own        | `env`, `clock`, `drainTimeoutMs` — as `StartOptions` states them.                                        |

A per-unit scope is not a `boot`/`StartOptions` concern any more: a runtime
opens one itself, through `UnitHost.fork`, so there is nothing here for a
fixture or a call to bind — see
[The Runtime contract](/reference/core/runtime#unithost-resolves).

**Teardown** runs per started application, in order: `stop()`,
then `exited` is awaited and examined. A **`Defect`** is rethrown, so a
shutdown that blew up fails the test even when the test never read `exited`;
a modeled `Err` passes through, since a startup failure is an outcome a test
may be asserting. `stop()` and the await are no-ops for an application the
test already drove to exit.

## `tapped(module, ports)`

<!-- doctest: skip — the quoted types name `TapGate`, the phantom gate `tapped` carries, which is internal and has no exported symbol to check against -->

```ts
const tapped: <X, E, N, const P extends readonly AnyPort[]>(
  module: Module<X, E, N>,
  ports: P & TapGate<P, X>,
) => {
  readonly module: Module<X, E, N>;
  readonly services: () => ServicesOf<P>;
};

type ServicesOf<P extends readonly AnyPort[]> = {
  readonly [K in keyof P]: ServiceOf<InstanceType<P[K]>>;
};

type TapGate<P extends readonly AnyPort[], X> = [
  Exclude<InstanceType<P[number]>, X>,
] extends [never]
  ? unknown
  : {
      readonly "NOT EXPORTED — tap only what the module exports": Exclude<
        InstanceType<P[number]>,
        X
      >;
    };
```

Read services out of a booted application. `start` hands the application
context to the runtime alone, so a test that wants the very `OrderRepository`
the running graph writes through — not a fresh one — has nothing to `ctx.get`
it with. `tapped` composes one more provider around `module`, depending on
`ports`, and remembers what it was built with.

| Member       | Semantics                                                                                                                                                                                                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`     | A `Module<X, E, N>` exporting **exactly what `module` exports** — the kernel still finds the runtime, the gate still sees the same `X`. Boot this one instead of `module`.                                                                                                                     |
| `services()` | The service instances behind `ports`, in order, as a tuple typed by `ServicesOf<P>` (`const [repository] = tap.services()`). **Throws** before the graph has been built: reading a tap nobody booted is a bug in the test, not a modeled outcome, so it is loud rather than an `undefined`.    |
| `TapGate`    | A marker intersected onto `ports`, refusing at the call site any port `module` does not export — with the port in the message; see [what it prints](#the-tap-gate) below. An application-scope service is the only thing there is to tap; a unit-scoped port exists only while a unit is open. |

### The tap gate

`tapped`'s marker rides the `ports` parameter the way [di's own entry points
gate their `module`](/reference/di/entry-points#the-gate): `unknown` when
every tapped port is exported, a one-property object otherwise, refused by
assignability with the port in the message. It is the fourth gate mechanism
in this repo, and the only one a **test** meets rather than a composing
application.

What it prints, measured on a one-port tap of a module that does not export
that port:

```text
error TS2345: Argument of type '[typeof Inner]' is not assignable to parameter of type 'readonly [typeof Inner] & { readonly "NOT EXPORTED — tap only what the module exports": Inner; }'.
  Property '"NOT EXPORTED — tap only what the module exports"' is missing in type '[typeof Inner]' but required in type '{ readonly "NOT EXPORTED — tap only what the module exports": Inner; }'.
```

The message ends on the port. (The gate was a conditional rest tuple until
issue #93 swept the last two arity gates — this one and di's entry points' —
onto the marker mechanism; the arity form printed `Expected 4 arguments, but
got 2.` and nothing else.)

The tap provider is not exported and nothing resolves it; di builds every
provider in a graph, exported or not, which is what makes the capture work.
Its port is declared once, so two `tapped` modules in one graph are di's
duplicate-provider defect at build — one tap per application is the shape.

A tap is for the **services** a spec drives or asserts against.
`examples/order-amqp-worker` taps the writer it places orders through and the
outbox it reads back, on a root composed to record what its logger wrote:

<!-- doctest: skip — needs `@btravstack/amqp-worker`, which packages/core does not install; the shape it shows is exercised by examples/order-amqp-worker's specs -->

```ts
const lines: Line[] = [];
const recording = AmqpModule("RecordingAmqpWorker")({
  needs: [Env],
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    OrderApplicationModule,
    OrderPersistenceModule,
    observability({ sink: (line) => lines.push(line) }),
  ],
  provides: [relayConfig, outboxRelay],
  exports: [PlaceOrder, OrderRepository, Outbox],
});

const tap = tapped(recording, [PlaceOrder, OrderRepository, Outbox]);
const app = await serve(tap.module);
const [placeOrder, repository, outbox] = tap.services();
```

Log lines are **not** what a tap is for, and `examples/order-api` no longer
uses one at all: [`observability({ sink })`](/reference/observability) is the
seam a spec reads a running graph's lines through, and what comes back is the
`Line` itself — `unit.traceId` as a field rather than a prefix parsed out of a
string. A sink is a value the composition takes, so nothing has to be reached
for inside the graph. See
[Log and correlate](/how-to/log-and-correlate).

## `overridden(module, overrides)`

<!-- doctest: skip — the quoted signature names di's `AnyProviderFor` and `ErrorsOf`, which are internal to that package -->

```ts
const overridden: <X, E, N, const O extends readonly AnyProviderFor[]>(
  module: Module<X, E, N>,
  overrides: O,
) => Module<X, E | ErrorsOf<O>, N>;
```

The real composition root with named providers substituted — the testing half
of "swapping an adapter is composing a different module", for the seam
composition cannot reach: nothing can be layered over a graph that already
provides a port (that is di's duplicate defect doing its job), so before this
helper a recording sink or a stubbed adapter meant a hand-maintained parallel
root that restated the real one and drifted from it silently (issue #63).

Each override is an ordinary `Provider(Port)(...)` — the service type is
checked against the port at that call. At build, di REPLACES the base
provider for that port: the base is never constructed (a resourceful base's
`acquire` never runs), and two invariants hold the line, both `WiringDefect`s
before any factory runs:

```text
[di] override for port "OrderRepository" with nothing to override — the tree no longer provides it
[di] two overrides registered for port "Logger"
```

The first is the drift gate: a fixture overriding a port the root stops
providing fails loudly instead of diverging. An override's own deps resolve
from the graph's **internals** (a recording logger reading the real
`LoggerConfig`) and deliberately do not widen the returned `Needs` — they are
checked at build by the missing-provider defect instead. And an override
replaces one **provider**, never a subsystem: the replaced provider's
siblings still construct, so swapping a whole adapter stack — or a graph
whose shape varies per test — remains a different module composed in its
place, as `examples/order-temporal-worker`'s fixture shows.

`overridden` rides `overrideProvider`, the one deliberately test-facing
export in `@btravstack/di`'s own surface; a production root that reaches for
either is recomposing the lazy way.

## `testRuntime(name?, options?)`

<!-- doctest: signature=@btravstack/testing -->

```ts
const testRuntime: (name?: string, options?: TestRuntimeOptions) => TestRuntime; // name defaults to "test"

type TestRuntime = Runtime<never, TestRuntimeInfo> & {
  readonly module: Module<TestRuntimePort, never, never>;
  readonly started: () => boolean;
  readonly untilStarted: () => AsyncResult<void, never>;
  readonly accepting: () => boolean;
  readonly serving: () => Serving<TestRuntimeInfo>;
  readonly host: () => RuntimeHost<never>;
  readonly submit: <T = string, E = never>() => SubmittedUnit<T, E>;
};

type TestRuntimeOptions = {
  readonly unit?: Module<never, never, unknown>;
};

type TestRuntimeInfo = { readonly name: string };
class TestRuntimePort extends RuntimePort<Runtime<never, TestRuntimeInfo>> {}

type SubmittedUnit<T, E> = {
  readonly settle: (result: Result<T, E>) => void;
  readonly result: AsyncResult<T, E>;
  readonly signal: AbortSignal;
};
```

| Member                      | Semantics                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `resolves`, `start` | The `Runtime` half: `resolves` is `[]`; `start` records the `RuntimeHost` it was called with, starts accepting, publishes `{ name }` on `Serving.info` and answers `Ok(serving)`.                                                                                                                                                                   |
| `module`                    | A `Module` providing **this** runtime on `TestRuntimePort` — the shape a runtime package ships, sized for a test. Import it next to the module under test and export `TestRuntimePort`, and `start` finds it. It provides this very object: a wrapper built by spreading (`{ ...runtime, start }`) still carries a module that boots the inner one. |
| `started()`                 | `true` once the kernel has called `start`.                                                                                                                                                                                                                                                                                                          |
| `untilStarted()`            | Resolves the first time the kernel calls `start`. What a test awaits before `submit()`, since `start` itself is only called once the graph is built.                                                                                                                                                                                                |
| `accepting()`               | `true` between `start` and the first of `drain` / `stop`. Lets a test observe **when** the kernel told the runtime to stop accepting, which the drain's ordering turns on.                                                                                                                                                                          |
| `serving()`                 | The `Serving` handed to the kernel. **Throws** if the runtime was never started — a loud fixture misuse, not a modeled outcome.                                                                                                                                                                                                                     |
| `host()`                    | The `RuntimeHost` the kernel last called `start` with. **Throws** if the runtime was never started — same rationale as `serving()`.                                                                                                                                                                                                                 |
| `submit()`                  | Opens a unit through the kernel's `run` with `{ kind: "test", id: "<n>" }` (`n` counts up from `1`, so ids stay unique). Returns a `SubmittedUnit`. **Throws** when not accepting.                                                                                                                                                                  |

`options.unit` is a module every submitted unit forks through `UnitHost.fork`,
with no seed, before its work runs — the same mechanism a real runtime drives,
exercised without booting one. `SubmittedUnit` is how a test holds a unit open
across a drain: `settle` is the unit's own outcome, `result` is what the
kernel hands back for it, and `signal` is the unit's `AbortSignal` —
forwarded, so it is valid immediately after `submit()` even when a bound
`unit` module defers the work by an `await`.

`testRuntime` deliberately **ignores** the `Serving.drain(signal)` deadline:
its `drain` flips `accepting` and returns at once. That is what makes the
abort tests tests of the kernel, not of the fake.

## `createFakeClock(start?)`

<!-- doctest: signature=@btravstack/testing -->

```ts
const createFakeClock: (start?: number) => FakeClock; // start defaults to 0

type FakeClock = Clock & {
  readonly advance: (ms: number) => AsyncResult<void, never>;
};
```

A `Clock` whose time moves only on `advance(ms)`. Pass it as
`StartOptions.clock` to drive the pre-drain delay and the drain deadline
explicitly instead of waiting out the real `5_000`/`20_000` ms.

| Member               | Semantics                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `now()`              | The current fake time.                                                                                                                                                                                                                                                                                                          |
| `sleep(ms, signal?)` | Pending until `advance` carries `now` past `now + ms`. `ms <= 0` or an already-aborted `signal` resolves at once; a later abort resolves it and forgets it, so the kernel's second-signal `skip` cannot hang.                                                                                                                   |
| `advance(ms)`        | Moves `now` forward and resolves every sleep whose deadline has passed. It **brackets itself with a real macrotask** at each end, so a test can trigger a shutdown and advance in the very next statement without racing the kernel arming its next sleep; when it settles, the application is where the elapsed time takes it. |

Timing in the kernel's own suite is asserted through this clock, never a real
`setTimeout`.

## Together

The kernel-level pieces, composed as `packages/core`'s compiled README sample
does:

<!-- doctest: isolate
import { Module, Port, Provider } from "@btravstack/di";
import { Ok } from "unthrown";
import { expect, test } from "vitest";
import {
  TestRuntimePort,
  bootFixture,
  createFakeClock,
  testRuntime,
  type Boot,
} from "@btravstack/testing";
class Greeter extends Port("Greeter")<{ readonly greet: () => string }> {}
const AppModule = Module("App")({
  provides: [Provider(Greeter)({ inject: {}, value: { greet: () => "hi" } })],
  exports: [Greeter],
});
-->

```ts
import { Module } from "@btravstack/di";
import {
  TestRuntimePort,
  bootFixture,
  createFakeClock,
  testRuntime,
  type Boot,
} from "@btravstack/testing";
import { Ok } from "unthrown";
import { expect, test } from "vitest";

const it = test.extend<{ boot: Boot }>({ boot: bootFixture() });

it("drains in-flight work", async ({ boot }) => {
  const clock = createFakeClock();
  const runtime = testRuntime();
  const TestApp = Module("TestApp")({
    imports: [AppModule, runtime.module],
    exports: [TestRuntimePort],
  });

  const app = boot(TestApp, { clock, preDrainDelayMs: 5_000 });
  await runtime.untilStarted();
  const unit = runtime.submit<string>();

  app.requestDrain();
  await clock.advance(5_000); // the pre-drain delay

  unit.settle(Ok("done"));
  expect(await unit.result).toBeOkWith("done");

  // Ok({ reason: "signal", drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 }, … })
  expect(await app.exited).toBeOk();
});
```

## Summary of exports

| Export               | Kind                                    |
| -------------------- | --------------------------------------- |
| `bootFixture`        | function — a `test.extend` fixture body |
| `Boot`               | type — what the fixture hands the test  |
| `BootDefaults`       | type — `Omit<StartOptions, "signals">`  |
| `tapped`             | function                                |
| `ServicesOf`         | type                                    |
| `overridden`         | function                                |
| `testRuntime`        | function                                |
| `TestRuntimePort`    | port class, declared over `RuntimePort` |
| `TestRuntime`        | type                                    |
| `TestRuntimeInfo`    | type                                    |
| `TestRuntimeOptions` | type — `testRuntime`'s second parameter |
| `SubmittedUnit`      | type                                    |
| `createFakeClock`    | function                                |
| `FakeClock`          | type                                    |

The generated signatures are at [`/api/testing/`](/api/testing/).
