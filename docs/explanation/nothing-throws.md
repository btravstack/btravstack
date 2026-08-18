---
title: Nothing throws
description: Why start returns a Result and never calls process.exit, why every async surface is an AsyncResult, how failures are classified by phase, and how runMain closes the exit-0-after-a-crash hole.
---

# Nothing throws

> **Explanation.** This page explains three of the kernel's theses together —
> `start` never throws, every async surface is an `AsyncResult`, and the
> startup error channel is the application's own — plus the failure model and
> exit codes they produce. For the code table, see [`runMain` and exit
> codes](/reference/core/exit-codes); to run without `runMain`, see [Embed
> without runMain](/how-to/embed-without-run-main).

`start` **never throws and never calls `process.exit`**. It returns a
`RunningApp` whose `exited` is an `AsyncResult<ExitReport, E |
RuntimeStartFailed>`, and every failure route — a construction error, a
runtime that refused to start, a probe port already taken, an uncaught
exception, a finaliser that failed — lands in one of that value's channels.

That is what makes the kernel embeddable. A dev runner can boot two
applications side by side; a test file can boot a dozen; nothing any of them
does can end the process or escape as an exception into another's `await`.
The one place a process's fate is decided is `runMain`, and even there it sets
`process.exitCode` rather than calling `process.exit()`, so pending output
flushes, an embedding host keeps control of its own lifetime, and a test can
observe the code without the run ending.

## Every async surface is an `AsyncResult`

Not only the fallible ones. `AsyncResult<T, never>` is this package's spelling
of "async, and cannot fail" — what `fromSafePromise` produces — and it is
used everywhere a bare `Promise<void>` would otherwise appear: `probePort()`,
`runtimeInfo()`, `Clock.sleep`, `FakeClock.advance`, `UnitRegistry.awaitIdle`,
`TestRuntime.untilStarted`, a probe server's `close`. The point is
**uniformity**: every async surface awaits into a `Result`, so a caller never
has to remember which ones did and which returned a bare value.

`unthrown/prefer-async-result` cannot enforce this — it flags a
`Promise<Result<T, E>>`, and a `Promise<void>` is not `Result`-bearing — so it
is a convention held by review, with exactly four exceptions, each documented
where it lives — and all but the first are one exception wearing different
hats: **a test's assertion failure has to reach the test runner as a throw**,
and an `AsyncResult` never rejects.

- **`runMain` returns `Promise<void>`.** Its whole job is to _leave_ the
  `Result` world and become an exit code. It is the boundary, and a top-level
  `await runMain(...)` in an entry point is the intended shape.
- **`UnitWork`'s `Promise<Result<T, E>>` arm** exists to accept a _caller's_
  `async` handler without a wrapper at every call site; `run` normalises it
  internally.
- **`bootFixture`** — and `unitFixture` — in `@btravstack/testing`: vitest's
  own `(ctx, use) => Promise<void>` fixture protocol, which the harness does
  not get to choose. `use` is the test body: a thrown assertion failure inside
  it must reach the test runner, and an `AsyncResult` never rejects, so
  wrapping it would turn a failing `expect` into a `Defect` a caller can forget
  to unwrap — a green test that asserted nothing. `bootFixture`'s teardown
  rethrows a shutdown `Defect` so the runner sees that too.
- **`TestRuntime.inUnit` / `InUnit`**, in `@btravstack/testing`, returning
  `Promise<T>`. Same argument with nothing to soften it: `work` **is** the
  assertion, since the fixture exists to run an `expect` against something that
  read the ambient record. It is deliberately not the harness's own error
  channel either — a unit the _kernel_ could not run is still a `Defect`, and
  surfaces as one.

## The startup channel is the application's own

`start` takes a `Module<X, E, Scope | Env>` and returns
`AsyncResult<ExitReport, E | RuntimeStartFailed>`. **`E` is the module's own
error type, passed through unwrapped and still typed.** A `ConfigInvalid` from
a configuration provider arrives at `exited` as a `ConfigInvalid`, not as a
`KernelStartupError` with a `cause` you have to `instanceof` your way back out
of.

Wrapping was the obvious design and it was rejected because it erases the
model. `Module.scoped` already reports the module's `E`; a kernel wrapper
would take a type the application spent effort naming and hand back
`unknown` inside an envelope. The kernel adds exactly one error of its own,
`RuntimeStartFailed`, because it is genuinely the kernel's — a port in use, a
broker unreachable, a probe port taken — and it is the only error the kernel
mints.

## Failures, classified by phase

Each phase of a process's life has one honest channel, and the classification
is what makes the exit code small.

- **Startup — a modeled `Err`.** The application's `E`, or the kernel's
  `RuntimeStartFailed`. Reported as a `startFailed` event before `stopping`, so
  a process that never came up says why on stderr.
- **Wiring — a `Defect`, untouched.** A cycle or a duplicate provider arrives
  from `di` as a defect and stays one. A wiring bug is not an outcome a caller
  branches on.
- **Teardown — visible, never masking.** A failing finaliser cannot overwrite
  why the process stopped; the kernel collects each into
  `ExitReport.teardownErrors` and emits a `teardownError` event.
- **Unit failures never reach the kernel.** A handler's `Err` is the runtime's
  to map (see [The kernel maps nothing](/explanation/the-kernel-maps-nothing)).
- **`uncaughtException` / `unhandledRejection` — readiness false, then
  straight to `stopping`, skipping the drain.** Deliberately harsher than a
  signal, for a reason on [Draining, in three
  beats](/explanation/draining-in-three-beats): after an uncaught throw the
  process state may be corrupt. Only the first is reported.

`runMain` folds those into a table:

| Code | Meaning                                                           |
| ---- | ----------------------------------------------------------------- |
| `0`  | exited cleanly — nothing abandoned, no teardown error             |
| `1`  | a modeled startup `Err`                                           |
| `2`  | drained with work abandoned, **or** exited with teardown errors   |
| `70` | an uncaught exception or unhandled rejection; or a defect         |
| `78` | a `ConfigInvalid` — including a `RuntimeStartFailed` carrying one |

`70` and `78` are sysexits(3)'s `EX_SOFTWARE` and `EX_CONFIG`. The two `70`s
are one statement — an internal software error — reached through the two
channels a bug can take. `78` says "the deployment is wrong, not the code": the
one startup failure an operator fixes without a rebuild, and the kernel's own
`PROBE_PORT` earns it too, which is why a bad one is a `RuntimeStartFailed`
for `"probes"` with the `ConfigInvalid` as its `cause`.

Two orderings in that table are written out rather than left implicit. **A
crash outranks abandoned work**: the uncaught path skips the drain, so in
practice `drain` is `undefined` when `reason` is `"uncaught"`, but the code is
decided from `reason` first so the precedence does not depend on that. And
**`2` is earned by a failed finaliser as much as by abandoned work**: a
connection pool that could not flush is exactly the shutdown an orchestrator
must not be told succeeded, and the kernel goes to real trouble to keep those
errors observable — reporting `0` over them would waste it.

## The footgun `runMain` closes

`start` installs `uncaughtException` and `unhandledRejection` handlers, because
it needs to know a crash happened to force readiness false and stop. And
**installing either suppresses Node's own default exit code of `1`** —
measured: a process that throws from a timer exits `1` bare and `0` with a
no-op handler installed.

So an embedder that uses `start` _without_ `runMain`, and sets no exit code
of its own, gets a **silent exit `0` after a crash**. The process reports
success to its orchestrator. This is the reason the `uncaught` row exists in
the table at all, and why it maps to `70` rather than falling through to `0`.
An embedder that will not use `runMain` has two honest options: fold
`ExitReport.reason` into an exit code itself —

```ts
const embed = async (): Promise<void> => {
  const app = start(TickerApp, { signals: true });
  const report = await app.exited;

  process.exitCode = report.match({
    ok: (exit) => (exit.reason === "uncaught" ? 70 : 0),
    errCases: (matcher) => matcher.with(P.tag("RuntimeStartFailed"), () => 1),
    defect: () => 70,
  });
};
```

— or pass `signals: false`, which turns off the uncaught handlers _and_ the
signal handlers together, at the cost of the signal-driven drain. One flag for
both families, because both are process-global and a test harness needs them
off together.

## Events, not a logger

The kernel takes no logger dependency. It emits **nine structured events** —
`building`, `startFailed`, `serving`, `draining`, `drained`, `stopping`,
`exited`, `teardownError`, `uncaught` — to whatever `onEvent` sink it is
given, and the default `stderrSink` writes one JSON line per event.

Two details of that sink are load-bearing. An `Error` cause is normalised to
`{ name, message, stack, cause }`, because `JSON.stringify` skips
non-enumerable properties and a bare `Error` would render the two
cause-carrying events as `{"cause":{}}`. And a cause it cannot serialise at
all — a circular object — falls back to `"[unserialisable]"` rather than
throwing, because a throwing sink is swallowed (a broken reporter must not take
the process down mid-shutdown), and the crash would then be reported nowhere.

That the events go somewhere else is the point of the seam.
[`@btravstack/observability`](/reference/observability) ships the logging half
of it: `kernelEvents(logger)` is an `EventSink` that writes each event as a log
line on the application's own logger — `startFailed` and `uncaught` at `error`
carrying their cause, `teardownError` at `warn`, the rest at `info`, with each
event's own fields as attributes — so `serving` lands next to the request that
was in flight when it did instead of in a second stream with a second shape.
The OpenTelemetry half is not written. The kernel is unchanged either way: it
is where the events come from, not where they go, and it still takes no logger
dependency.

## Where to go next

- The decisions behind the surface, including why `RuntimeStartFailed` is the
  only kernel error: [Design decisions](/explanation/design-decisions).
- The complete code table with its inputs:
  [`runMain` and exit codes](/reference/core/exit-codes).
