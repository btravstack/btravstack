# @btravstack/core

> The application kernel: boot a [`@btravstack/di`](../di) module into a
> running process, and stop it again without losing work — one lifecycle state
> machine, one unit-of-work registry, one `Runtime` contract. It knows nothing
> about HTTP, AMQP or Temporal, never throws, and never calls `process.exit`.

📖 **[Documentation](https://btravstack.github.io/btravstack/)** ·
[Get Started](https://btravstack.github.io/btravstack/tutorial/getting-started) ·
[Reference](https://btravstack.github.io/btravstack/reference/core/start) ·
[API Reference](https://btravstack.github.io/btravstack/api/core/)

```sh
pnpm add @btravstack/core @btravstack/config @btravstack/di unthrown
```

`@btravstack/config`, `@btravstack/di` and `unthrown` are **peer
dependencies** — install all four. The kernel itself depends on `node:`
builtins only. Node `>=22`.

## A worked example

An application is a di module. A **runtime** is a service of that module,
provided on a port declared over `RuntimePort`; `start` finds it there, builds
the graph, and drives what it finds. The transport starters
([`@btravstack/http-server`](../http-server), [`@btravstack/temporal-worker`](../temporal-worker),
[`@btravstack/amqp-worker`](../amqp-worker)) provide real runtimes; this one is a timer, so
the sample stays self-contained:

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
    Provider(Greeter)({
      inject: {},
      value: { greet: (name: string) => `hello, ${name}` },
    }),
  ],
  exports: [Greeter],
});

// A runtime owns the transport; the kernel owns the lifecycle. This one is a
// timer, so the sample stays self-contained — no published runtime models a
// timer, and `@btravstack/http-server` would pull in a real dependency this
// sample doesn't need.
const ticker: Runtime<typeof Greeter> = {
  name: "ticker",
  resolves: [Greeter],
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
  provides: [Provider(Ticker)({ inject: {}, value: ticker })],
  exports: [Greeter, Ticker],
});

await runMain(TickerApp);
```

`runMain` is the front door: it boots the module, awaits the application's exit
and turns the outcome into a process exit code — one call, and the whole of a
`main.ts`. Underneath it is `start`, which returns immediately with a
`RunningApp` and decides nothing about the process. The runtime's declared
`needs` are checked against the module's exports **at compile time** — a
`TickerApp` that does not export `Greeter` is a type error at the call, and so
is a module that exports no runtime port at all.

## For a runtime author

Two helpers sit beside the `Runtime` contract, because every transport needs
them and none should own a private copy:

- **`releasedBy(signal, running)`** — `running`, but no later than the kernel's
  drain deadline, for a `Serving.drain` whose work settles on somebody else's
  clock.
- **`traceIdOfTraceparent(header)`** — the trace-id field of a W3C
  `traceparent`, and nothing else of it: the parent's span id is dropped, since
  `UnitMeta.traceId` is a correlation id rather than a span context. Answers
  `undefined` for anything the specification calls invalid — a malformed
  header, an all-zero trace id, an all-zero parent id, the reserved version
  `ff` — so your runtime falls back to its own id instead of adopting one that
  means nothing. A higher version's extra fields are read rather than refused.

## What you get

- **A drain that survives Kubernetes.** On SIGTERM: readiness flips false, the
  kernel waits `preDrainDelayMs` (`PRE_DRAIN_DELAY_MS`, default `5_000`) before
  telling the runtime to stop accepting — endpoint removal is eventually
  consistent — then in-flight work gets `drainTimeoutMs` (`DRAIN_TIMEOUT_MS`,
  default `20_000`); whatever is still open is aborted and reported
  `abandoned`. A second signal skips the drain. Both timings have to agree with
  the pod's `terminationGracePeriodSeconds`, which is why the deployment can
  set them and the option only pins them.
- **Probes from the state machine.** `GET /livez` and `GET /readyz` on
  `PROBE_PORT` (default `9000`), up before the graph is built.
- **Configuration from the environment, typed.** The kernel provides
  [`@btravstack/config`](../config)'s `Env` port to every graph it boots; a
  bad value is a `ConfigInvalid` naming every fault at once, and exit `78`.
- **Teardown on every path**, with failing finalisers in
  `ExitReport.teardownErrors`, never masking the exit reason.
- **A per-unit scope no handler manages** — pass a module as
  `StartOptions.unit` and the kernel forks it around every unit.
- **An ambient record, not an ambient container** — `currentUnit()` reads
  `{ unitId, traceId, tenantId, signal }`; services never travel
  there. `signal` is the very `AbortSignal` the unit's work callback is handed,
  so a runtime whose work is a library's `next()` — a Temporal activity, an
  AMQP delivery — can still honour the drain deadline.
- **Nothing throws.** Every async surface is an
  [`unthrown`](https://github.com/btravstack/unthrown) `AsyncResult`;
  `runMain` sets `process.exitCode` — `0` clean, `1` a modeled startup error,
  `2` abandoned work or a failed finaliser, `70` a crash, `78` a bad
  environment.

Every sample above is compiled by
[`src/docs-examples.test-d.ts`](./src/docs-examples.test-d.ts). The rest —
the `Runtime` contract, the drain, embedding without `runMain` — is on the
[documentation site](https://btravstack.github.io/btravstack/reference/core/start).
Testing what the kernel boots is [`@btravstack/testing`](../testing)'s job — a
`bootFixture` for `test.extend`, `tapped` to read services out of a running
app, an in-memory runtime and a fake clock — kept out of this package so a
production bundle never pulls the fakes in.

## License

[MIT](./LICENSE) © Benoit TRAVERS
