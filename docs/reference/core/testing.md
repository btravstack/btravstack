---
title: Testing entry point
description: The @btravstack/core/testing surface — testRuntime and TestRuntimePort, createFakeClock, withApp — with every member's signature and semantics.
---

# Testing entry point

> **Reference.** Everything `@btravstack/core/testing` exports: an in-memory
> runtime, a clock that moves on demand, and a harness that starts and stops
> an application around a test body. For the recipes, see
> [Test an application](/how-to/test-an-application); for the option each
> plugs into, see [start and StartOptions](/reference/core/start).

`@btravstack/core/testing` is a **second entry point**, kept out of the main
one so a production bundle never pulls the fakes in.

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

## `withApp(module, options, use)`

```ts
const withApp: <X, E, A, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, Scope | Env>,
  options: StartOptions<UnitX, UnitNeeds>,
  use: (app: RunningApp<E, RuntimeInfoOf<X>>) => Promise<A>,
  ...gate: StartGate<X, UnitNeeds>
) => Promise<A>;
```

Start the application, hand it to `use`, and stop it again **whatever `use`
does**. It carries the same phantom gate as `start`.

| Behaviour                                 | Detail                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `signals` and `probes` are **forced off** | Whatever the caller passes. Process-wide signal handlers would fight across a test file, and a probe port would collide between tests. A test needing the real probe server calls `start`.                                                                         |
| Always stops                              | After `use` settles, `app.stop()` then `await app.exited` — both no-ops if `use` already drove the application to exit.                                                                                                                                            |
| A throw from `use` outranks everything    | Held while the application is stopped, then rethrown unchanged — a failed `expect` reaches the runner as the throw it was, and a shutdown defect can never mask it.                                                                                                |
| A `Defect` on `exited` is rethrown        | Only a `Defect`. A shutdown that blew up fails the test even when `use` never read `exited`. A modeled `Err` (a startup failure) is an outcome a test may be asserting, so it passes through.                                                                      |
| Speaks a bare `Promise`                   | Both `withApp` and `use` — the one harness-shaped exception to the package's `AsyncResult` rule. `use` is the test body, and an `AsyncResult` never rejects, so wrapping either side would turn a failing assertion into a `Defect` a caller can forget to unwrap. |

## Together

The three, composed as `packages/core`'s compiled README sample does:

```ts
import { Module } from "@btravstack/di";
import {
  TestRuntimePort,
  createFakeClock,
  testRuntime,
  withApp,
} from "@btravstack/core/testing";
import { Ok } from "unthrown";
import { expect } from "vitest";

const clock = createFakeClock();
const runtime = testRuntime();
const TestApp = Module("TestApp")({
  imports: [AppModule, runtime.module],
  exports: [TestRuntimePort],
});

const report = await withApp(TestApp, { clock }, async (app) => {
  await runtime.untilStarted();
  const unit = runtime.submit<string>();

  app.requestDrain();
  await clock.advance(5_000); // the pre-drain delay

  unit.settle(Ok("done"));
  expect(await unit.result).toBeOkWith("done");

  return await app.exited;
});
// report: Ok({ reason: "signal", drain: { inFlightAtStart: 1, completed: 1, abandoned: 0 }, … })
```

## Summary of exports

| Export            | Kind                                    |
| ----------------- | --------------------------------------- |
| `testRuntime`     | function                                |
| `TestRuntimePort` | port class, declared over `RuntimePort` |
| `TestRuntime`     | type                                    |
| `TestRuntimeInfo` | type                                    |
| `SubmittedUnit`   | type                                    |
| `createFakeClock` | function                                |
| `FakeClock`       | type                                    |
| `withApp`         | function                                |
