# @btravstack/start

**The application kernel: boot a [`@btravstack/di`](https://github.com/btravstack/di)
module into a running process, and stop it again without losing work.**

[![npm version](https://img.shields.io/npm/v/%40btravstack%2Fstart.svg?logo=npm)](https://www.npmjs.com/package/@btravstack/start)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`di` proves an application's wiring before the process exists. `start` owns
**when** that already-proven graph is constructed and torn down: one lifecycle
state machine, one unit-of-work registry, one `Runtime` contract. It knows
nothing about HTTP, AMQP or Temporal, it never throws, and it never calls
`process.exit`.

## Install

```sh
pnpm add @btravstack/start @btravstack/di unthrown
```

`@btravstack/di` and `unthrown` are **peer dependencies** — install all three.
The kernel itself has no runtime dependencies beyond `node:` builtins.
Node `>=20`.

## A worked example

```ts
import { Module, Port, Provider } from "@btravstack/di";
import { runMain, start, type Runtime, type Serving } from "@btravstack/start";
import { Ok, OkAsync } from "unthrown";

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

const AppModule = Module("App")({
  provides: [
    Provider(Greeter)({ value: { greet: (name: string) => `hello, ${name}` } }),
  ],
  exports: [Greeter],
});

// A runtime owns the transport; the kernel owns the lifecycle. This one is a
// timer, so the sample stays self-contained — `@btravstack/start-http` and its
// siblings are not written yet.
const ticker: Runtime<typeof Greeter> = {
  name: "ticker",
  needs: [Greeter],
  start: (host) => {
    const timer = setInterval(() => {
      // Every piece of work goes through `host.run`: that is what makes it
      // count towards the drain, and what gives it an `AbortSignal`.
      //
      // The unit's `Result` is the runtime's to map — the kernel hands it back
      // and stays out of it. A timer has nowhere to return one, so it observes
      // it instead; dropping it would hide the work's `Err` *and* a `Defect`.
      void host
        .run({ kind: "tick", id: `${Date.now()}` }, (ctx, signal) =>
          signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
        )
        .tapFailure((failure) => {
          process.stderr.write(`${JSON.stringify({ tick: failure.tag })}\n`);
        });
    }, 1_000);

    const serving: Serving = {
      // Stop accepting new work. In-flight units are the kernel's business.
      drain: () => {
        clearInterval(timer);
        return OkAsync();
      },
      stop: () => OkAsync(),
    };

    return OkAsync(serving);
  },
};

await runMain(start(AppModule, { runtime: ticker }));
```

The runtime's declared `needs` are checked against the module's exports at
compile time: booting `ticker` against a module that does not export `Greeter`
is a type error at the `start` call.

## What you get

- **A drain that survives Kubernetes.** On SIGTERM: readiness flips false,
  then the kernel waits `preDrainDelayMs` (default `5_000`) **before** telling
  the runtime to stop accepting — endpoint removal is eventually consistent, so
  a pod that stops accepting immediately rejects traffic the ingress is still
  routing to it. In-flight work then gets `drainTimeoutMs` (default `20_000`);
  whatever is still open is aborted and reported as `abandoned`. A second signal
  skips the drain.
- **Probes from the state machine.** `GET /livez` and `GET /readyz` on a
  separate `node:http` server (default port `9000`, `127.0.0.1`, `unref`'d;
  `probes: false` to disable). A Temporal worker with no HTTP runtime gets
  probes for free.
- **Teardown on every path.** `start` is a thin wrapper over `Module.scoped`,
  so LIFO release, close-on-failure and non-masking finaliser errors are
  inherited from `di`, not reimplemented. Failing finalisers surface in
  `ExitReport.teardownErrors`.
- **A channel for what a runtime is.** A runtime that binds `port: 0` publishes
  `Serving.info`, and the caller reads it back through `app.runtimeInfo()` — so
  no runtime has to invent an `onListening` hook. The shape is the runtime's own
  (a queue consumer has no port), and publishing is optional: `Info` defaults to
  `never`.
- **Unit tracking the runtimes do not implement.** `host.run` counts open
  units and hands each one an `AbortSignal`, which is what makes
  `DrainReport.abandoned` accurate without cooperation.
- **An ambient record, not an ambient container.** One `AsyncLocalStorage`
  store per unit holding `{ unitId, traceId, tenantId, deadline }` — data,
  never capabilities. Read it with `currentUnit()`.
- **Events, not a logger.** `building`, `serving`, `draining`, `drained`,
  `stopping`, `exited`, `teardownError`, `uncaught` — JSON to stderr by
  default, or your own `onEvent` sink.
- **Every async surface is an `AsyncResult`**, including the infallible ones:
  `AsyncResult<T, never>` is how this package spells "async, and cannot fail",
  so `app.probePort()`, `clock.sleep(ms)` and friends all
  await into a `Result`. The three exceptions are `runMain` (the boundary out of
  the Result world), `UnitWork`'s `Promise<Result>` arm (it accepts your own
  `async` handler) and `withApp`/`use` (a thrown assertion must reach the test
  runner).

## Writing a runtime

A runtime owns the transport and nothing else — the contract is `Runtime`,
`RuntimeHost`, `RunUnit` and `Serving`, and the `ticker` above is a complete
one. Two obligations come with it that the kernel **cannot check for you**, and
building the first real runtime on this contract hit both.

**Flush the response inside the unit.** A unit is closed the instant its
`Result` settles; an idle registry is what the drain waits for, and going idle
is the kernel's permission to call `Serving.stop()`. A runtime that resolves the
unit and _then_ writes its response is racing `stop()` tearing the transport
down — with a small body the write usually wins, with a large one it does not
(measured with an 8 MB body: `UND_ERR_SOCKET: other side closed`). Do the write
inside the `host.run(...)` callback and only settle the unit once it has
flushed.

**`UnitMeta.id` must be unique per unit** unless you pass a `traceId`, because
`traceId` defaults to it. An HTTP runtime submitting the route template
(`"POST /orders"`) as the id gives every request the same trace id, which
silently defeats the point of the ambient record. A route template is a `kind`,
not an `id`. `UnitRecord.unitId` is minted per unit and always unique, so
telling two units apart never needs `traceId`; `traceId` is the **correlation**
id, carrying an id from outside the process (a `traceparent` header, a message
property) so a line logged here joins a trace that started elsewhere.

## Exit codes

`runMain` sets `process.exitCode` and never calls `process.exit()`.

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | exited cleanly, or drained with nothing abandoned       |
| `1`  | startup failure (a modeled `Err`)                       |
| `2`  | drained with work abandoned                             |
| `70` | stopped by an uncaught exception or unhandled rejection |
| `70` | a defect                                                |

Both `70`s are sysexits(3)'s `EX_SOFTWARE`. A crash takes precedence over
abandoned work.

### Embedding without `runMain` — read this

`start` installs `uncaughtException` and `unhandledRejection` handlers, and
**installing either suppresses Node's own default exit code of 1**. An embedder
that uses `start` _without_ `runMain` and sets no exit code of its own therefore
gets a **silent exit 0 after a crash**.

Use `runMain`, or decide the code yourself:

```ts
const embed = async (): Promise<void> => {
  const app = start(AppModule, { runtime: ticker, signals: true });
  const report = await app.exited;

  process.exitCode = report.match({
    ok: (exit) => (exit.reason === "uncaught" ? 70 : 0),
    errCases: (matcher) => matcher.with(P.tag("RuntimeStartFailed"), () => 1),
    defect: () => 70,
  });
};
```

(`signals: false` turns off the uncaught handlers _and_ the signal handlers
together — the other way out, at the cost of no signal-driven drain.)

## Testing

`@btravstack/start/testing` ships `createFakeClock`, `testRuntime` and
`withApp`.

```ts
const drainTest = async (): Promise<void> => {
  const clock = createFakeClock();
  const runtime = testRuntime();

  const report = await withApp(AppModule, { runtime, clock }, async (app) => {
    await runtime.untilStarted();
    const unit = runtime.submit<string>();

    app.requestDrain();
    await clock.advance(5_000); // the pre-drain delay

    unit.settle(Ok("done"));
    // The unit's own outcome, asserted rather than awaited for its timing
    // alone — a bare `await unit.result;` would drop it.
    expect(await unit.result).toBeOkWith("done");

    return await app.exited;
  });

  // `{ inFlightAtStart: 1, completed: 1, abandoned: 0 }`.
  expectTypeOf(report.getOrThrow().drain).toEqualTypeOf<
    DrainReport | undefined
  >();
};
```

`withApp` forces `signals` and `probes` off whatever the caller passes:
process-wide handlers would fight across a test file, and a probe port would
collide between tests. It **rethrows a `Defect`** on `exited`, so a shutdown
that blew up fails the test even when `use` never looked at `exited`; a modeled
`Err` passes through untouched, being an outcome a test may legitimately be
asserting.

## Options

| Option            | Default          |                                                               |
| ----------------- | ---------------- | ------------------------------------------------------------- |
| `runtime`         | —                | required; the one runtime this process boots                  |
| `clock`           | `systemClock`    | injectable, so drain tests are instant                        |
| `signals`         | `true`           | `false` disables the SIGTERM/SIGINT **and** uncaught handlers |
| `probes`          | `{ port: 9000 }` | `false` to disable; `{ port: 0 }` to let the OS choose        |
| `preDrainDelayMs` | `5_000`          | beat 2 of the drain                                           |
| `drainTimeoutMs`  | `20_000`         | beat 3; keep it under `terminationGracePeriodSeconds`         |
| `onEvent`         | JSON to stderr   | a throwing sink is swallowed                                  |

## Documentation

The full write-up — the theses, the load-bearing invariants with the test that
guards each, the internal design notes and the map of the planned runtime
packages — lives in the repository:
[github.com/btravstack/start](https://github.com/btravstack/start).

## License

[MIT](./LICENSE) © Benoit TRAVERS
