# @btravstack/core

**The application kernel: boot a [`@btravstack/di`](https://github.com/btravstack/di)
module into a running process, and stop it again without losing work.**

[![npm version](https://img.shields.io/npm/v/%40btravstack%2Fcore.svg?logo=npm)](https://www.npmjs.com/package/@btravstack/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

`di` proves an application's wiring before the process exists. `start` owns
**when** that already-proven graph is constructed and torn down: one lifecycle
state machine, one unit-of-work registry, one `Runtime` contract. It knows
nothing about HTTP, AMQP or Temporal, it never throws, and it never calls
`process.exit`.

## Install

```sh
pnpm add @btravstack/core @btravstack/di unthrown
```

`@btravstack/di` and `unthrown` are **peer dependencies** — install all three.
The kernel itself has no runtime dependencies beyond `node:` builtins.
Node `>=20`.

## A worked example

```ts
import { Module, Port, Provider } from "@btravstack/di";
import {
  RuntimePort,
  runMain,
  start,
  type Runtime,
  type Serving,
} from "@btravstack/core";
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
// timer, so the sample stays self-contained — no published runtime models a
// timer, and `@btravstack/http` would pull in a real dependency this
// sample doesn't need.
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

// A runtime is a service the module provides, on a port declared over
// `RuntimePort` — `start` finds it by that port in the module's exports. The
// composition root is what differs between an `api`, a `worker` and a
// `consumer` process; the application module is the same in all three.
class Ticker extends RuntimePort<Runtime<typeof Greeter>> {}

const TickerApp = Module("TickerApp")({
  imports: [AppModule],
  provides: [Provider(Ticker)({ value: ticker })],
  exports: [Greeter, Ticker],
});

await runMain(TickerApp);
```

`runMain` is the front door — boot the module, await the exit, set the process
exit code, one call. `start` is the same boot returning the `RunningApp`
instead of deciding the process's fate; it is what tests and embedders use.
The runtime's declared `needs` are checked against the module's exports at
compile time: a `TickerApp` that does not export `Greeter` is a type error at
the call, and so is a module that exports no runtime port at all.

## What you get

- **A drain that survives Kubernetes.** On SIGTERM: readiness flips false,
  then the kernel waits `preDrainDelayMs` (default `5_000`) **before** telling
  the runtime to stop accepting — endpoint removal is eventually consistent, so
  a pod that stops accepting immediately rejects traffic the ingress is still
  routing to it. In-flight work then gets `drainTimeoutMs` (default `20_000`);
  whatever is still open is aborted and reported as `abandoned`. A second signal
  skips the drain.
- **Probes from the state machine.** `GET /livez` and `GET /readyz` on a
  separate `node:http` server (`127.0.0.1`, `unref`'d; the port is `PROBE_PORT`
  from the environment, default `9000`; `probes: false` to disable). A Temporal
  worker with no HTTP runtime gets probes for free.
- **Configuration from the environment, typed.** `Config.provider(Port)(Config.object({...}))` binds a port from the `Env` the kernel provides to
  every graph — validated once as the graph is built, every fault named at
  once, exit `78` under `runMain`. See _Configuration_ below.
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
- **A per-unit scope no handler manages.** Pass a module as
  `StartOptions.unit` and the kernel forks it around every unit: built as the
  unit opens, torn down — while the unit's ambient record is still open — as
  it closes, reading anything the application context carries. Unit work
  receives the forked `Context`, so a request-scoped provider reaches a
  handler with no `Module.forkScope` in sight. Its error channel is `never` by
  design: a construction failure at unit scope rides the unit's defect path,
  which every runtime already answers.
- **An ambient record, not an ambient container.** One `AsyncLocalStorage`
  store per unit holding `{ unitId, traceId, tenantId, deadline }` — data,
  never capabilities. Read it with `currentUnit()`.
- **Events, not a logger.** `building`, `startFailed`, `serving`, `draining`,
  `drained`, `stopping`, `exited`, `teardownError`, `uncaught` — JSON to
  stderr by default, or your own `onEvent` sink.
- **Every async surface is an `AsyncResult`**, including the infallible ones:
  `AsyncResult<T, never>` is how this package spells "async, and cannot fail",
  so `app.probePort()`, `clock.sleep(ms)` and friends all
  await into a `Result`. The three exceptions are `runMain` (the boundary out of
  the Result world), `UnitWork`'s `Promise<Result>` arm (it accepts your own
  `async` handler) and `withApp`/`use` (a thrown assertion must reach the test
  runner).

## Configuration

Twelve-factor configuration is the environment and nothing else, so the kernel
provides it as a port: `Env`, `process.env` by default (`StartOptions.env` for
a test), reaching every graph `start` boots. A configuration provider is a
provider that reads it — built with the rest of the graph, injected like any
other service, and a bad environment is a modeled startup `Err` rather than a
crash or a silently wrong value.

```ts
import { Config } from "@btravstack/config";

class Settings extends Port("Settings")<{
  readonly port: number;
}> {}

const SettingsModule = Module("Settings")({
  provides: [
    Config.provider(Settings)(
      Config.object({
        port: Config.port("PORT", { default: 3000 }),
      }),
    ),
  ],
  exports: [Settings],
});

const ConfiguredApp = Module("ConfiguredApp")({
  imports: [TickerApp, SettingsModule],
  exports: [Greeter, Ticker, Settings],
});

// `process.env` in production; a test hands in the record it wants, and reads
// `PROBE_PORT` from it too unless `probes` is set.
await runMain(ConfiguredApp);
const configured = start(ConfiguredApp, { env: { PORT: "0" }, probes: false });
```

- `Config.string(VAR, { default? })`, `Config.integer(VAR, { min?, max?,
default? })` and `Config.port(VAR, { default? })` each read one variable. **Unset** takes the default, or is "is
  required" without one; **set but empty or blank is an error**, never an
  absent variable — `PORT=` would otherwise bind whatever the empty string
  coerces to. `PORT=0` stays legal, since an ephemeral bind must be
  expressible.
- `Config.object({...})` composes fields into a Standard Schema over the
  environment; every field is read, so one validation names every offending
  variable at once. Any other Standard Schema — a `zod` object over the raw
  variables — is accepted in its place, with no adapter.
- `Config.provider(Port)(schema)` is a di provider needing `Env` (which the
  kernel discharges) with error `ConfigInvalid` — a `TaggedError` carrying
  `{ port, issues }` whose message names each variable. It flows through
  `start`'s error channel typed, like any application error, and **`runMain`
  exits `78`** (sysexits' `EX_CONFIG`) on it. The kernel binds its own
  `PROBE_PORT` the same way.

A starter provides its own slice — `@btravstack/http`'s `http()` binds `PORT`
and `HOST` onto `HttpConfig` — and an application binds whatever else it
needs onto ports of its own. Nothing else should touch `process.env`.

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

**`host.ctx` is the application context, and unit work is deferred.** Both
follow from `StartOptions.unit`. A port the unit module provides exists only
while a unit is open and reaches you through `host.run`'s work callback alone —
the gate lets your `needs` name it, so `host.ctx.get(...)` of one type-checks
and is a defect at startup; resolve at `start` only what the application module
itself exports. And with a unit module the work runs only once the fork is
built, so if you subscribe to an event from inside it (a response's `'close'`),
check first whether it already fired — a client that hung up during a slow
per-request acquire otherwise leaves the unit open for good.

## Exit codes

`runMain` sets `process.exitCode` and never calls `process.exit()`.

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | exited cleanly, with nothing abandoned and teardown clean   |
| `1`  | startup failure (a modeled `Err`)                           |
| `2`  | drained with work abandoned, or exited with teardown errors |
| `70` | stopped by an uncaught exception or unhandled rejection     |
| `70` | a defect                                                    |
| `78` | a configuration port could not be bound (`ConfigInvalid`)   |

Both `70`s are sysexits(3)'s `EX_SOFTWARE`. A crash takes precedence over
abandoned work. `78` is `EX_CONFIG` — the deployment is wrong, not the code —
and covers the kernel's own `PROBE_PORT` too. Every startup failure is also
reported as a `startFailed` event, so a bad environment is named on stderr
rather than exiting silently.

`2` means "we stopped, but not cleanly", and a failed finaliser earns it just as
abandoned work does: a non-empty `ExitReport.teardownErrors` is never a `0`.

### Embedding without `runMain` — read this

`start` installs `uncaughtException` and `unhandledRejection` handlers, and
**installing either suppresses Node's own default exit code of 1**. An embedder
that uses `start` _without_ `runMain` and sets no exit code of its own therefore
gets a **silent exit 0 after a crash**.

Use `runMain`, or decide the code yourself:

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

(`signals: false` turns off the uncaught handlers _and_ the signal handlers
together — the other way out, at the cost of no signal-driven drain.)

## Testing

`@btravstack/core/testing` ships `createFakeClock`, `testRuntime` (with its
port, `TestRuntimePort`, and `.module`, which provides itself on that port)
and `withApp`.

```ts
const drainTest = async (): Promise<void> => {
  const clock = createFakeClock();
  const runtime = testRuntime();
  // The in-memory runtime ships as a module: import it next to the application
  // and export its port, exactly as a real runtime package is composed in.
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

| Option            | Default        |                                                                                        |
| ----------------- | -------------- | -------------------------------------------------------------------------------------- |
| `env`             | `process.env`  | the environment, provided to the graph as `Env`; a test passes `{ PORT: "0", … }`      |
| `unit`            | none           | a module forked around every unit; see above                                           |
| `clock`           | `systemClock`  | injectable, so drain tests are instant                                                 |
| `signals`         | `true`         | `false` disables the SIGTERM/SIGINT **and** uncaught handlers                          |
| `probes`          | `PROBE_PORT`   | bound from `env` (default `9000`) when unset; `false` to disable; `{ port: 0 }` for OS |
| `preDrainDelayMs` | `5_000`        | beat 2 of the drain                                                                    |
| `drainTimeoutMs`  | `20_000`       | beat 3; keep it under `terminationGracePeriodSeconds`                                  |
| `onEvent`         | JSON to stderr | a throwing sink is swallowed                                                           |

## Documentation

The full write-up — the theses, the load-bearing invariants with the test that
guards each, the internal design notes and the map of the planned runtime
packages — lives in the repository:
[github.com/btravstack/start](https://github.com/btravstack/start).

## License

[MIT](./LICENSE) © Benoit TRAVERS
