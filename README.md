<div align="center">

# start

**The application kernel for [TypeScript](https://www.typescriptlang.org/) —
boot a [`@btravstack/di`](https://github.com/btravstack/di) module into a running
process, and stop it again without losing work.**

[![CI](https://github.com/btravstack/start/actions/workflows/ci.yml/badge.svg)](https://github.com/btravstack/start/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40btravstack%2Fstart.svg?logo=npm)](https://www.npmjs.com/package/@btravstack/start)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue?logo=typescript)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

</div>

`di` proves an application's wiring before the process exists. `start` owns
**when** that already-proven graph is constructed and torn down, and nothing
more: one lifecycle state machine, one unit-of-work registry, one `Runtime`
contract. It knows nothing about HTTP, AMQP or Temporal.

It owns the things every backend process gets wrong on its own — a graceful
drain that survives Kubernetes' eventually-consistent endpoint removal,
liveness and readiness that answer from the state machine rather than a
transport, and a teardown that runs on every path. Nothing throws: `start`
returns an [`unthrown`](https://github.com/btravstack/unthrown) `Result`, and it
never calls `process.exit`.

## Install

```sh
pnpm add @btravstack/start @btravstack/di unthrown
```

`@btravstack/di` and `unthrown` are **peer dependencies** — install all three.
The kernel itself has no runtime dependencies beyond `node:` builtins.

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
      void host.run({ kind: "tick", id: `${Date.now()}` }, (ctx, signal) =>
        signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
      );
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

`start` returns immediately with a `RunningApp`; `runMain` awaits its
`exited` and turns the outcome into a process exit code. The runtime's declared
`needs` are checked against the module's exports **at compile time** — booting
`ticker` against a module that does not export `Greeter` is a type error at the
`start` call, not a boot-time crash.

Every code sample on this page is compiled by
[`packages/start/src/docs-examples.test-d.ts`](./packages/start/src/docs-examples.test-d.ts),
so a sample that stops compiling fails the build.

## What it is not

NestJS's `NestFactory.create(AppModule)` **is** the wiring step: Nest reads
decorator metadata at runtime, resolves tokens, builds the injector graph, and
throws at boot when something is missing. The graph is discovered while the
process starts.

`di` proves the graph before the process exists, so `start` does not wire.

|                    | NestJS                                                 | `di` + `start`                                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------- |
| Wiring declared by | decorators + metadata reflection                       | explicit `Module`/`Provider` values                     |
| Missing dependency | boot-time exception                                    | compile error                                           |
| Module privacy     | enforced at runtime                                    | compile error                                           |
| Cycles             | `forwardRef()`                                         | detected pre-construction, as a defect                  |
| Request scope      | request-scoped providers bubble up the injection chain | `forkScope` — parent services seeded, not reconstructed |
| Lifecycle hooks    | 5 interfaces + `enableShutdownHooks()`                 | `onStart`/`onStop` per provider; `start` owns signals   |
| Failures           | thrown                                                 | `Result`                                                |

The accepted cost is that there is **no auto-discovery**: the provider and its
dependency array are written out, and that array is what buys the compile-time
checking.

## One process, one runtime

The kernel knows several _kinds_ of runtime. A process boots exactly one.

An `api` deployment, a `consumer` deployment and a `worker` deployment are three
processes booting the **same** module with a different runtime. They scale, fail
and deploy independently, and it removes a whole class of design problem: there
is never a question of how two runtimes in one process share a drain deadline,
or whose failure takes the process down.

## The `Runtime` contract

```ts
type Runtime<Needs extends AnyPort> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (
    host: RuntimeHost<Needs>,
  ) => AsyncResult<Serving, RuntimeStartFailed>;
};

type RuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
  readonly run: RunUnit<Needs>;
};

type Serving = {
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
};
```

A runtime receives a **host**, not a bare `Context`: it needs both the
application services and the kernel's `run`, and handing it a `Context` alone
would leave it inventing its own unit tracking — the thing the kernel exists to
own.

`Serving.drain` returns `void`, not a report. Only the kernel can see the unit
registry, so the kernel — not the runtime — owns the accounting. `drain` means
"stop accepting"; the `AbortSignal` it receives fires when the kernel's own
deadline passes, so a runtime never does arithmetic on time.

`Runtime`, `RuntimeHost` and `RunUnit` are parameterised by port **classes**
(`Needs extends AnyPort`) but hand out `Context<InstanceType<Needs>>`, because
`di` parameterises `Context<in R>` by port **instance** types.

## The unit of work

Every runtime does the same thing in a loop: take one piece of work, run it,
produce an outcome. The kernel names that a **unit** and owns it, so three
runtimes do not each invent it.

```ts
const submitOne = (
  run: RunUnit<typeof Greeter>,
  meta: UnitMeta,
): AsyncResult<string, never> =>
  run(meta, (ctx, signal) =>
    signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
  );
```

`run` is transparent to the work's own channels: whatever `Result` the handler
produces is what the runtime receives back. The kernel observes only that the
unit settled — and **in-flight tracking falls out of this**. The kernel counts
open units, so `drain` means only "stop accepting" and `DrainReport.abandoned`
is accurate without any cooperation from the runtime.

**The kernel never maps an outcome to a transport.** `Result` → HTTP status
belongs to the HTTP runtime, `Result` → ack/nack/DLQ to the AMQP runtime,
`Result` → activity failure to the Temporal runtime. The kernel hands back the
`Result` and stays out of it.

Per-unit ports are not wired yet: `run` currently hands the work the
_application_ `Context`. `RunUnit` is typed so a `Module.forkScope` call can
land there without a signature change.

## Every async surface is an `AsyncResult`

Not only the fallible ones. `AsyncResult<T, never>` is how this package spells
"async, and cannot fail" — exactly what `fromSafePromise` produces — so
`app.probePort()`, `clock.sleep(ms)`, `clock.advance(ms)`,
`registry.awaitIdle()`, `runtime.untilStarted()` and a probe server's `close()`
all await into a `Result`. A caller never has to remember which async surfaces
returned a `Result` and which returned a bare value.

Three surfaces are deliberately outside it:

- **`runMain`** returns `Promise<void>`. Its job is to _leave_ the Result world
  and become a process exit code — it is the boundary.
- **`UnitWork`'s `Promise<Result<T, E>>` arm**, which exists to accept your own
  `async` handler.
- **`withApp` and its `use` callback.** `use` is the test body: a thrown
  assertion failure must reach the test runner, and an `AsyncResult` never
  rejects — so wrapping it would turn a failing `expect` into a `Defect` you can
  forget to unwrap, which is a green test that asserted nothing.

## Lifecycle

```
building ──▶ starting ──▶ serving ──▶ draining ──▶ stopping ──▶ exited
   │            │            │                        ▲
   └────────────┴────────────┴────────────────────────┘
              (any failure short-circuits to stopping)
```

The tracker is monotonic: a phase can only ever move forward, and re-entering
one is a no-op.

### Draining, in three beats

1. Readiness flips `false`, and the unit counts are sampled — synchronously,
   before anything else.
2. The kernel waits `preDrainDelayMs` (default `5_000`) **before** telling the
   runtime to stop accepting.
3. In-flight work gets `drainTimeoutMs` (default `20_000`) to finish; whatever
   is still open at that deadline is aborted and reported as `abandoned`.

Beat 2 looks like a pointless sleep and is not. Kubernetes endpoint removal is
eventually consistent, so a pod that stops accepting the instant SIGTERM lands
rejects traffic the ingress is still routing to it. That window is what the
delay closes.

`drainTimeoutMs` sits deliberately under the Kubernetes
`terminationGracePeriodSeconds` default of 30s, leaving headroom for `stopping`
before SIGKILL. Raise one and you must raise the other.

Only a **signal** drains. A plain `stop()` and an uncaught exception both go
straight to `stopping`, leaving `ExitReport.drain` `undefined`. A **second
signal skips the drain** — double Ctrl-C in development, an operator's escape
hatch in production.

Draining produces a value, not a log line:

```ts
type DrainReport = {
  readonly inFlightAtStart: number; // units in flight when the drain began
  readonly completed: number; // units that closed during the drain
  readonly abandoned: number; // units still open at the deadline
};
```

`completed` may exceed `inFlightAtStart` if in-flight work spawned more units
during the drain. That is honest reporting, not a bug — it is counted from a
monotonic total precisely so it can never go negative.

## Probes

Liveness and readiness are process-level concerns, not transport-level ones, so
the kernel runs its own `node:http` probe server on a separate port (default
`9000`, `probes: false` to disable, `{ port: 0 }` to let the OS choose and read
it back from `app.probePort()`, an `AsyncResult<number | undefined, never>`):

| Route         | 200                                         | 503           |
| ------------- | ------------------------------------------- | ------------- |
| `GET /livez`  | `ok` — any phase before `exited`            | `unavailable` |
| `GET /readyz` | `ready` — `serving`, and not forced unready | `unavailable` |

Anything else answers 404. The server binds **`127.0.0.1` only** and is
`unref`'d, so it never keeps the event loop alive. A bind failure is a startup
failure: it stops the graph being built at all, and surfaces as
`RuntimeStartFailed({ runtime: "probes" })`.

This is how a Temporal worker pod with no HTTP runtime still gets probes, and
why an HTTP runtime never has to expose `/healthz` on the public port. There is
deliberately no separate startup probe: `/livez` answers from `building` onward,
so a slow-building graph is covered by `/readyz` alone.

Readiness is a one-way latch — once forced false, by a drain or an uncaught
exception, it never returns to true. `app.ready()` reads the same predicate
synchronously, which is what an embedder wires into a health endpoint of its own
when `probes: false`.

## Ambient carries data, `Context` carries capabilities

The kernel opens one `AsyncLocalStorage` store per unit holding a small, fixed
record — `{ unitId, traceId, tenantId, deadline }` — and nothing else. Services
never go in it.

```ts
const log = (message: string): void => {
  const unit = currentUnit();
  process.stderr.write(
    `${JSON.stringify({ message, traceId: unit?.traceId })}\n`,
  );
};
```

The line holds because what `di` exists to prevent is hidden _dependencies_:
code that secretly needs a collaborator it never declared and cannot be tested
without it. A trace id is not a collaborator — there is no substitutability
question and no test double. A repository pulled from an ambient store is the
untestable coupling; a tenant id read by the Postgres adapter is not.

Legitimate readers are infrastructure adapters only — logger, OTel exporter,
database adapter. Application code reading the store is meant to be a lint
error; **that rule is not written yet** (it needs a convention for identifying
an adapter, which this stack has not established), so for now it is a
convention, not an enforcement.

## `runMain` and exit codes

`runMain` is the single sanctioned place this package decides a process's fate.
It sets `process.exitCode` and **never calls `process.exit()`**, so pending
output is flushed and an embedding host keeps control of its own lifetime.

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | exited cleanly, or drained with nothing abandoned       |
| `1`  | startup failure (a modeled `Err`)                       |
| `2`  | drained with work abandoned                             |
| `70` | stopped by an uncaught exception or unhandled rejection |
| `70` | a defect                                                |

The two `70`s are the same statement — sysexits(3)'s `EX_SOFTWARE`, an internal
software error — reached through the two channels a bug can take. A crash takes
precedence over abandoned work.

### Embedding without `runMain` — read this

`start` installs `uncaughtException` and `unhandledRejection` handlers, and
**installing either suppresses Node's own default exit code of 1**. So an
embedder that uses `start` _without_ `runMain` and sets no exit code of its own
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
together, which is the other way out — at the cost of no signal-driven drain.)

## Failure model

Failures are classified by **phase**, and each phase has one honest channel.

- **Startup — a modeled `Err`.** `start` returns
  `AsyncResult<ExitReport, E | RuntimeStartFailed>`, where `E` is the
  _application module's own_ error type, passed through **unwrapped and still
  typed**. The kernel adds only `RuntimeStartFailed`, which is genuinely its
  own (a port in use, a broker unreachable, a probe port taken).
- **Wiring — a `Defect`, untouched.** A cycle or a duplicate provider arrives
  from `di` as a defect and stays one. A wiring bug is not something a caller
  branches on.
- **Teardown — visible, never masking.** `di` guarantees a failing finaliser
  cannot overwrite the real failure; the kernel collects them into
  `ExitReport.teardownErrors`, and a failing release never rewrites the reason
  the application stopped.
- **Unit failures never reach the kernel.** A handler's `Err` is the runtime's
  to map.
- **`uncaughtException` / `unhandledRejection` — readiness false, then straight
  to `stopping`, skipping the drain.** Deliberately harsher than the signal
  path: after an uncaught throw the process state may be corrupt, so draining
  in-flight work risks completing it _wrongly_. Half-finished correct work beats
  confidently-wrong finished work. Only the first one is reported.

## Events, not a logger

The kernel emits structured events and takes no logger dependency:

| Event           | Payload         |
| --------------- | --------------- |
| `building`      | —               |
| `serving`       | `runtime`       |
| `draining`      | `inFlight`      |
| `drained`       | `report`        |
| `stopping`      | —               |
| `exited`        | —               |
| `teardownError` | `port`, `cause` |
| `uncaught`      | `cause`         |

The default sink writes one JSON line per event to stderr. A throwing sink is
swallowed: a broken reporter must not take the process down mid-shutdown.

## Testing

`@btravstack/start/testing` ships the deterministic half of the lifecycle.

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
    await unit.result;

    return await app.exited;
  });

  // `{ inFlightAtStart: 1, completed: 1, abandoned: 0 }`.
  expectTypeOf(report.getOrThrow().drain).toEqualTypeOf<
    DrainReport | undefined
  >();
};
```

- `createFakeClock()` — time moves only when the test says so, so a drain test
  is instant rather than twenty-five seconds long. `advance` brackets itself
  with a real macrotask at each end, so the code under test has reacted by the
  time it resolves.
- `testRuntime()` — an in-memory `Runtime` that lets units be held open, so
  drain behaviour can be proved with no transport.
- `withApp(module, options, use)` — starts, hands the app to `use`, and stops
  it again whatever `use` does. `signals` and `probes` are **forced off**
  whatever the caller passes: process-wide handlers would fight across a test
  file, and a probe port would collide between tests.

There is deliberately no `overrideProvider`. Swapping an adapter is composing a
different module, which `di` already documents and the type checker already
verifies.

## The runtime map

The `Runtime` contract is the whole of what this package owes the transports.
**None of the runtime packages below exist yet** — they are planned, not
published:

| Planned package              | Would own                                          |
| ---------------------------- | -------------------------------------------------- |
| `@btravstack/start-http`     | routing, middleware, `Result` → HTTP status        |
| `@btravstack/start-amqp`     | the consumer runtime, over `amqp-contract`         |
| `@btravstack/start-temporal` | the worker runtime, over `temporal-contract`       |
| an observability package     | logger and OpenTelemetry, binding to `KernelEvent` |

Until one lands, a runtime is roughly forty lines — the `ticker` above is a
complete one.

## Documentation

See [`packages/start`](./packages/start) for the package README, and
[`CLAUDE.md`](./CLAUDE.md) for the authoritative spec: the theses, the
load-bearing invariants with the test that guards each, and the internal design
notes.

## License

[MIT](./LICENSE) © Benoit TRAVERS
