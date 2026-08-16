---
title: "@btravstack/testing"
description: The @btravstack/testing surface — bootFixture and Boot, tapped, testRuntime and TestRuntimePort, createFakeClock — with every member's signature and semantics.
---

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

```ts
const bootFixture: (
  defaults?: BootDefaults,
) => (ctx: object, use: (boot: Boot) => Promise<void>) => Promise<void>;

type Boot = <X, E, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, Scope | Env>,
  options?: Omit<StartOptions<UnitX, UnitNeeds>, "signals">,
  ...gate: StartGate<X, UnitNeeds>
) => RunningApp<E, RuntimeInfoOf<X>>;

type BootDefaults = Omit<StartOptions, "signals" | "unit">;
```

A `test.extend` fixture that hands the test a `Boot` — `start`, with the
same signature and the same phantom gate, minus `signals` — and **stops every
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
| everything else   | `start`'s own        | `env`, `unit`, `clock`, `drainTimeoutMs` — as `StartOptions` states them.                                |

`unit` is excluded from `BootDefaults` on purpose: a unit module is a
composition's choice, not a fixture's, so it goes on the call
(`boot(OrderApi, { unit: RequestModule })`) — or on a fixture of your own
that wraps `boot`, which is what `examples/order-api`'s `serve` is.

**Teardown** runs per started application, in order: `stop()`,
then `exited` is awaited and examined. A **`Defect`** is rethrown, so a
shutdown that blew up fails the test even when the test never read `exited`;
a modeled `Err` passes through, since a startup failure is an outcome a test
may be asserting. `stop()` and the await are no-ops for an application the
test already drove to exit.

## `tapped(module, ports)`

```ts
const tapped: <X, E, N, const P extends readonly AnyPort[]>(
  module: Module<X, E, N>,
  ports: P,
  ...gate: [Exclude<InstanceType<P[number]>, X>] extends [never]
    ? []
    : [error: "NOT EXPORTED", missing: Exclude<InstanceType<P[number]>, X>]
) => {
  readonly module: Module<X, E, N>;
  readonly services: () => ServicesOf<P>;
};

type ServicesOf<P extends readonly AnyPort[]> = {
  readonly [K in keyof P]: ServiceOf<InstanceType<P[K]>>;
};
```

Read services out of a booted application. `start` hands the application
context to the runtime alone, so a test that wants the very `OrderRepository`
the running graph writes through — not a fresh one — has nothing to `ctx.get`
it with. `tapped` composes one more provider around `module`, depending on
`ports`, and remembers what it was built with.

| Member       | Semantics                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`     | A `Module<X, E, N>` exporting **exactly what `module` exports** — the kernel still finds the runtime, the gate still sees the same `X`. Boot this one instead of `module`.                                                                                                                  |
| `services()` | The service instances behind `ports`, in order, as a tuple typed by `ServicesOf<P>` (`const [repository] = tap.services()`). **Throws** before the graph has been built: reading a tap nobody booted is a bug in the test, not a modeled outcome, so it is loud rather than an `undefined`. |
| `...gate`    | Phantom, at the call site: `NOT EXPORTED` names any port `module` does not export. An application-scope service is the only thing there is to tap; a unit-scoped port exists only while a unit is open.                                                                                     |

The tap provider is not exported and nothing resolves it; di builds every
provider in a graph, exported or not, which is what makes the capture work.
Its port is declared once, so two `tapped` modules in one graph are di's
duplicate-provider defect at build — one tap per application is the shape.

A tap is for the **services** a spec drives or asserts against.
`examples/order-amqp-worker` taps the writer it places orders through and the
outbox it reads back, on a root composed to record what its logger wrote:

```ts
const lines: Line[] = [];
const recording = AmqpModule("RecordingAmqpWorker")({
  contract: orderContract,
  handlers: orderHandlers,
  imports: [
    ApplicationModule,
    PersistenceModule,
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

## `testRuntime(name?)`

```ts
const testRuntime: (name?: string) => TestRuntime; // name defaults to "test"

type TestRuntime = Runtime<never, TestRuntimeInfo> & {
  readonly module: Module<TestRuntimePort, never, never>;
  readonly started: () => boolean;
  readonly untilStarted: () => AsyncResult<void, never>;
  readonly accepting: () => boolean;
  readonly serving: () => Serving<TestRuntimeInfo>;
  readonly submit: <T = string, E = never>() => SubmittedUnit<T, E>;
};

type TestRuntimeInfo = { readonly name: string };
class TestRuntimePort extends RuntimePort<Runtime<never, TestRuntimeInfo>> {}

type SubmittedUnit<T, E> = {
  readonly settle: (result: Result<T, E>) => void;
  readonly result: AsyncResult<T, E>;
  readonly signal: AbortSignal;
};
```

| Member                   | Semantics                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `needs`, `start` | The `Runtime` half: `needs` is `[]`; `start` records `host.run`, starts accepting, publishes `{ name }` on `Serving.info` and answers `Ok(serving)`.                                                                                                                                                                                                |
| `module`                 | A `Module` providing **this** runtime on `TestRuntimePort` — the shape a runtime package ships, sized for a test. Import it next to the module under test and export `TestRuntimePort`, and `start` finds it. It provides this very object: a wrapper built by spreading (`{ ...runtime, start }`) still carries a module that boots the inner one. |
| `started()`              | `true` once the kernel has called `start`.                                                                                                                                                                                                                                                                                                          |
| `untilStarted()`         | Resolves the first time the kernel calls `start`. What a test awaits before `submit()`, since `start` itself is only called once the graph is built.                                                                                                                                                                                                |
| `accepting()`            | `true` between `start` and the first of `drain` / `stop`. Lets a test observe **when** the kernel told the runtime to stop accepting, which the drain's ordering turns on.                                                                                                                                                                          |
| `serving()`              | The `Serving` handed to the kernel. **Throws** if the runtime was never started — a loud fixture misuse, not a modeled outcome.                                                                                                                                                                                                                     |
| `submit()`               | Opens a unit through the kernel's `run` with `{ kind: "test", id: "<n>" }` (`n` counts up from `1`, so ids stay unique). Returns a `SubmittedUnit`. **Throws** when not accepting.                                                                                                                                                                  |

`SubmittedUnit` is how a test holds a unit open across a drain: `settle` is
the unit's own outcome, `result` is what the kernel hands back for it, and
`signal` is the unit's `AbortSignal` — forwarded, so it is valid immediately
after `submit()` even when a `unit` module defers the work by an `await`.

`testRuntime` deliberately **ignores** the `Serving.drain(signal)` deadline:
its `drain` flips `accepting` and returns at once. That is what makes the
abort tests tests of the kernel, not of the fake.

## `createFakeClock(start?)`

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

| Export            | Kind                                             |
| ----------------- | ------------------------------------------------ |
| `bootFixture`     | function — a `test.extend` fixture body          |
| `Boot`            | type — what the fixture hands the test           |
| `BootDefaults`    | type — `Omit<StartOptions, "signals" \| "unit">` |
| `tapped`          | function                                         |
| `ServicesOf`      | type                                             |
| `testRuntime`     | function                                         |
| `TestRuntimePort` | port class, declared over `RuntimePort`          |
| `TestRuntime`     | type                                             |
| `TestRuntimeInfo` | type                                             |
| `SubmittedUnit`   | type                                             |
| `createFakeClock` | function                                         |
| `FakeClock`       | type                                             |

The generated signatures are at [`/api/testing/`](/api/testing/).
