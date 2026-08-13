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
// timer, so the sample stays self-contained — no published runtime models a
// timer, and `@btravstack/start-http` would pull in a real dependency this
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

[`examples/`](./examples) proves this rather than asserting it: one
clean-architecture application, booted by an oRPC runtime and by a queue-worker
runtime, with the application and persistence layers unchanged between them —
and the same `DuplicateOrder` arriving as a typed `CONFLICT` on one and as a
dead-letter on the other.

## The `Runtime` contract

```ts
type Runtime<Needs extends AnyPort, Info = never> = {
  readonly name: string;
  readonly needs: readonly Needs[];
  readonly start: (
    host: RuntimeHost<Needs>,
  ) => AsyncResult<Serving<Info>, RuntimeStartFailed>;
};

type RuntimeHost<Needs extends AnyPort> = {
  readonly ctx: Context<InstanceType<Needs>>;
  readonly run: RunUnit<Needs>;
};

type Serving<Info = never> = {
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
  readonly info?: Info;
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

### What a runtime publishes about itself

A runtime that binds `port: 0` knows which port it got, and nothing else does.
`Serving.info` is the channel for that, and `RunningApp.runtimeInfo()` is where
the caller reads it — so no runtime has to invent an `onListening` hook of its
own.

```ts
type HttpInfo = { readonly port: number };

const httpish: Runtime<typeof Greeter, HttpInfo> = {
  name: "httpish",
  needs: [Greeter],
  start: () =>
    OkAsync({
      drain: () => OkAsync(),
      stop: () => OkAsync(),
      // Whatever the runtime actually bound. A queue consumer has no port and
      // would publish `{ queue, prefetch }` instead — the shape is its own.
      info: { port: 8080 },
    }),
};

const app = start(AppModule, { runtime: httpish });
const info = await app.runtimeInfo(); // Result<HttpInfo | undefined, never>
```

`Info` defaults to `never`, so publishing is **optional**: a runtime with
nothing to say omits `info` and its type is unchanged. `runtimeInfo()` is
`probePort()` one layer up — the same deferred, settled when the runtime starts
serving and `undefined` on every route that never gets there, so it can never
hang.

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
belongs to the handler an application hands the HTTP runtime (oRPC, Hono, a
bare function — `@btravstack/start-http` itself declines that mapping),
`Result` → ack/nack/DLQ to the AMQP runtime, `Result` → activity failure to
the Temporal runtime. The kernel hands back the `Result` and stays out of it.

Per-unit ports are not wired yet: `run` currently hands the work the
_application_ `Context`. `RunUnit` is typed so a `Module.forkScope` call can
land there without a signature change.

### Two contracts a runtime owes

Neither is checkable by the kernel, and building the first real runtime on this
contract hit both.

**Flush the response _inside_ the unit.** A unit is closed the instant its
`Result` settles; an idle registry is what the drain waits for, and going idle
is the kernel's permission to call `Serving.stop()`. So a runtime that resolves
the unit and _then_ writes its response is racing `stop()` tearing the transport
down. With a small body the write usually wins; with a large one it does not
(measured with an 8 MB body: `UND_ERR_SOCKET: other side closed`). A unit is not
"compute the answer" — it is "compute the answer **and get it out of the
process**".

```ts
const serveOne = (
  host: RuntimeHost<typeof Greeter>,
  meta: UnitMeta,
  send: (body: string) => Promise<void>,
): AsyncResult<string, never> =>
  // Flushed inside the work callback. Sending after `await host.run(...)`
  // returns is the race: the unit is already closed by then.
  host.run(meta, async (ctx, signal) => {
    const body = signal.aborted ? "" : ctx.get(Greeter).greet("world");
    await send(body);
    return Ok(body);
  });
```

**`UnitMeta.id` must be unique per unit**, unless you pass a `traceId` — that is
what `traceId` defaults to. An HTTP runtime that submits the route template
(`"POST /orders"`) as the id gives every request the same trace id, and the
ambient record's whole purpose, telling one unit apart from another in a log
line, is silently defeated. A route template is a `kind`, not an `id`; a broker
message id or a queue job id is already unique and needs nothing more.

The kernel cannot check this — it would have to remember every id it had ever
seen. What it does guarantee is `UnitRecord.unitId`, minted per unit and always
unique, so a reader that only needs to tell two units apart already has one.
`traceId` is the **correlation** id, which is why it is the one a runtime may
supply: it carries an id from _outside_ the process (a `traceparent` header, a
message property) so a line logged here joins a trace that started elsewhere.

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

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | exited cleanly, with nothing abandoned and teardown clean   |
| `1`  | startup failure (a modeled `Err`)                           |
| `2`  | drained with work abandoned, or exited with teardown errors |
| `70` | stopped by an uncaught exception or unhandled rejection     |
| `70` | a defect                                                    |

The two `70`s are the same statement — sysexits(3)'s `EX_SOFTWARE`, an internal
software error — reached through the two channels a bug can take. A crash takes
precedence over abandoned work.

`2` is the one code an operator reads as "we stopped, but not cleanly", and two
facts earn it: work the drain ran out of time for, and a finaliser that failed
on the way out. The second matters as much as the first — a connection pool that
could not flush is exactly the shutdown an orchestrator must not be told
succeeded — which is why a non-empty `ExitReport.teardownErrors` is never a `0`.

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

- `createFakeClock()` — time moves only when the test says so, so a drain test
  is instant rather than twenty-five seconds long. `advance` brackets itself
  with a real macrotask at each end, so the code under test has reacted by the
  time it resolves.
- `testRuntime()` — an in-memory `Runtime` that lets units be held open, so
  drain behaviour can be proved with no transport.
- `withApp(module, options, use)` — starts, hands the app to `use`, and stops
  it again whatever `use` does. `signals` and `probes` are **forced off**
  whatever the caller passes: process-wide handlers would fight across a test
  file, and a probe port would collide between tests. It **rethrows a `Defect`**
  on `exited`, so a shutdown that blew up fails the test even when `use` never
  looked at `exited`; a modeled `Err` passes through untouched, being an outcome
  a test may legitimately be asserting. A test that wants to assert the defect
  itself calls `start` directly.

There is deliberately no `overrideProvider`. Swapping an adapter is composing a
different module, which `di` already documents and the type checker already
verifies.

## The runtime map

The `Runtime` contract is the whole of what this package owes the transports.
Two have shipped. [`@btravstack/start-http`](./packages/start-http): bind, one
unit per request, a drain that retires busy keep-alive connections, stop —
routing, middleware and `Result` → HTTP status are deliberately not included,
see its README's _"What it does not do"_.
[`@btravstack/start-temporal`](./packages/start-temporal): a Temporal worker,
one unit per activity attempt, and a drain that releases the kernel at the
kernel's deadline rather than Temporal's `shutdownForceTime`. The rest are
planned, not published:

| Planned package          | Would own                                          |
| ------------------------ | -------------------------------------------------- |
| `@btravstack/start-amqp` | the consumer runtime, over `amqp-contract`         |
| an observability package | logger and OpenTelemetry, binding to `KernelEvent` |

Until it lands, a runtime for `-amqp` is roughly forty lines — the `ticker`
above is a complete one. The two shipped packages are not: they exist because
the lifecycle underneath a real transport is not forty lines done well.

## Documentation

See [`packages/start`](./packages/start) for the package README,
[`examples/`](./examples) for an eight-package clean-architecture application
booted under three different runtimes, and [`CLAUDE.md`](./CLAUDE.md) for the
authoritative spec: the theses, the public surface and the conventions. The
load-bearing invariants with the test that guards each, and the internal design
notes, live in
[`packages/start/CLAUDE.md`](./packages/start/CLAUDE.md).

## License

[MIT](./LICENSE) © Benoit TRAVERS
