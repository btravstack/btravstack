---
title: The Runtime contract
description: Runtime, RuntimeHost, RunUnit, Serving, RuntimePort and RuntimeStartFailed, the unit-of-work types, currentUnit, Clock — and the three contracts a runtime owes that the kernel cannot check.
---

# The `Runtime` contract

> **Reference.** The service behind a runtime port, the host it is handed, the
> unit-of-work types, the ambient record and the clock. For writing one, see
> [Write a runtime](/how-to/write-a-runtime); for why the kernel maps nothing,
> see [The kernel maps nothing](/explanation/the-kernel-maps-nothing).

## `Runtime<Resolves, Info>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Runtime<Resolves extends AnyPort = never, Info = never> = {
  readonly name: string;
  readonly resolves: readonly Resolves[];
  readonly start: (
    host: RuntimeHost<Resolves>,
  ) => AsyncResult<Serving<Info>, RuntimeStartFailed>;
};
```

| Member     | Semantics                                                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`     | Reported on the `serving` event.                                                                                                                                                                                                                                                                                                      |
| `resolves` | The port **classes** the runtime resolves from `host.ctx`. `start`'s gate checks them against the module's exports at the call site. Every shipped starter declares `resolves: []` — what its handlers read is its provider's business, through di — so this is the general contract, used by `testRuntime` and hand-rolled runtimes. |
| `start`    | Called once, after the graph is built. `Ok(serving)` moves the phase to `serving`; `Err(RuntimeStartFailed)` is a startup failure the kernel reports through `exited`.                                                                                                                                                                |

`Resolves` is parameterised by port **classes** (`AnyPort`) but hands out
`Context<InstanceType<Resolves>>`, because di parameterises `Context<in R>` by
port **instance** types. `InstanceType<never>` is `never`, so a runtime that
resolves nothing gets a context it can read nothing from.

## `RuntimeHost<Resolves>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type RuntimeHost<Resolves extends AnyPort> = {
  readonly ctx: Context<InstanceType<Resolves>>;
  readonly run: RunUnit<Resolves>;
};
```

`ctx` is the **application** context — the module's exports, never a
`StartOptions.unit` module's. `run` is the kernel's unit registry, closed over
that context.

## `RunUnit<Resolves>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type RunUnit<Resolves extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (
    ctx: Context<InstanceType<Resolves>>,
    signal: AbortSignal,
  ) => ReturnType<UnitWork<T, E>>,
) => AsyncResult<T, E>;
```

Submit one piece of work as a **unit**. The kernel counts it towards the
drain, opens its ambient record, hands it an `AbortSignal` (fired at the drain
deadline, or at once when the drain is skipped — the same object is on the
record as `signal`, for a runtime whose work callback is a library's `next()`)
and gives the work's own
`Result` **straight back** — mapping that outcome to a transport is the
runtime's job. With a `unit` module, `ctx` is the forked context
(`Context<X | UnitX>`), built before `work` runs and torn down after it
settles.

## `Serving<Info>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Serving<Info = never> = {
  readonly drain: (signal: AbortSignal) => AsyncResult<void, never>;
  readonly stop: () => AsyncResult<void, never>;
  readonly info?: Info;
};
```

| Member  | Semantics                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `drain` | "Stop accepting." Returns `void`, **not** a `DrainReport` — only the kernel can see the unit registry, so the kernel owns the accounting. `signal` fires when the kernel's deadline passes; a runtime never does arithmetic on time. A runtime whose transport waits (a Temporal Worker's `run()`) must race the signal. |
| `stop`  | Tear the transport down. Called after the drain, or straight away when the drain is skipped.                                                                                                                                                                                                                             |
| `info`  | What the runtime publishes about **itself** once serving, read back through `RunningApp.runtimeInfo()`. `Info` defaults to `never`, so the field is unwritable and optional with no ceremony. It is deliberately not a port number: `{ port }` for an HTTP runtime, `{ taskQueue, namespace }` for a Temporal one.       |

Both are typed `AsyncResult<void, never>`; `never` empties the error channel
only, so a `drain` that throws internally arrives at the kernel as a `Defect`
and is threaded, not dropped.

## `RuntimePort`, `RuntimeInfoOf` and `RuntimeStartFailed`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
const RuntimePort = Port("Runtime"); // generic: no fixed service

class HttpRuntime extends RuntimePort<Runtime<never, HttpInfo>> {}
```

`RuntimePort` is the one port the kernel resolves its runtime from. Left
generic on purpose: every runtime port is **one id** at runtime — a process
boots exactly one — while each carries its own `Resolves`/`Info` in the type. A
runtime package declares its own class over it and ships a module providing it.
`RuntimeInfoOf<X>` reads the `Info` back out of a module's exports; it is the
only helper type of that family the package exports.

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
class RuntimeStartFailed extends TaggedError("RuntimeStartFailed")<{
  readonly runtime: string;
  readonly cause: unknown;
}> {}
// message: `the ${runtime} runtime failed to start`
```

The one error the kernel mints. A runtime answers it from `start`; the kernel
answers it with `runtime: "probes"` when the probe server cannot bind or
`PROBE_PORT` is malformed (its `cause` then a `ConfigInvalid`).

## Units of work

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type UnitMeta = {
  readonly kind: string;
  readonly id: string;
  readonly traceId?: string;
  readonly tenantId?: string;
  readonly deadline?: number;
};

type UnitWork<T, E> = (
  signal: AbortSignal,
) => AsyncResult<T, E> | Promise<Result<T, E>> | Result<T, E>;

type UnitRegistry = {
  readonly run: <T, E>(
    meta: UnitMeta,
    work: UnitWork<T, E>,
  ) => AsyncResult<T, E>;
  readonly inFlight: () => number;
  readonly closed: () => number;
  readonly abortAll: () => void;
  readonly awaitIdle: () => AsyncResult<void, never>;
};

type UnitRecord = {
  readonly unitId: string;
  readonly traceId: string;
  readonly tenantId: string | undefined;
  readonly deadline: number | undefined;
  readonly signal: AbortSignal;
};

const currentUnit: () => UnitRecord | undefined;
```

| Name            | Semantics                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnitMeta`      | What a runtime says about one unit as it submits it. `kind` is the category (`"http"`, `"tick"`, `"job"`); `id` identifies **this** unit. `traceId` defaults to `id`.                                                                                       |
| `UnitWork`      | The work callback. The `Promise<Result>` arm exists to accept a caller's `async` handler — the one place the package accepts a bare `Promise` on purpose. Whatever `Result` it settles is what `run` hands back; a throw becomes a `Defect`.                |
| `UnitRegistry`  | The kernel's own accounting, exposed as a type. `closed()` is monotonic; `awaitIdle()` answers about the registry at the instant it is called and is what beat 3 of the drain races.                                                                        |
| `UnitRecord`    | The ambient record, opened in an `AsyncLocalStorage` store for the unit's whole extent. `unitId` is minted per unit and always unique; `traceId` is the correlation id; `signal` is the **same** `AbortSignal` `UnitWork` receives as its argument.         |
| `currentUnit()` | The ambient read; `undefined` outside a unit. Its legitimate readers are infrastructure adapters (a logger, an OTel exporter, a database adapter) — see [Read the ambient unit from an adapter](/how-to/read-the-ambient-unit). Not enforced by lint today. |

## `Clock` and `systemClock`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Clock = {
  readonly now: () => number;
  readonly sleep: (
    ms: number,
    signal?: AbortSignal,
  ) => AsyncResult<void, never>;
};
```

`systemClock` is `Date.now` plus a `setTimeout` that resolves early when
`signal` aborts (a second SIGTERM cuts the pre-drain delay short) and is
`unref`'d, so a shutdown sleep never keeps the event loop alive.
`createFakeClock()` from `@btravstack/testing` is the other implementation.

## Three contracts a runtime owes

None of these is checkable by the kernel, and each is silent when broken.
[Write a runtime](/how-to/write-a-runtime) shows how to keep them.

1. **Flush the response inside the unit.** A unit is closed the instant its
   `Result` settles, and an idle registry is the kernel's permission to call
   `Serving.stop()`. A runtime that resolves the unit and _then_ writes to its
   client is racing the transport's teardown — measured: an 8 MB body loses
   with `UND_ERR_SOCKET: other side closed`.
2. **`UnitMeta.id` must be unique per unit unless a `traceId` is supplied.**
   `traceId` defaults to `id`, so passing a category (a route template) as the
   id gives every request the same trace id. A broker message id or job id is
   already unique; a route template is a `kind`.
3. **`RuntimeHost.ctx` is the application context, and unit work is not
   synchronous with `host.run`.** A unit-provided port reaches the runtime only
   through `run`'s work callback, and with a `unit` module the callback runs
   after an `await` — a runtime subscribing to an event from inside it must
   check whether it already fired (`@btravstack/http-server` checks `response.closed`
   for exactly this).

## A minimal runtime

The smallest runtime that keeps all three, from `packages/core`'s compiled
README samples — a timer, so nothing external is pulled in:

```ts
import { RuntimePort, type Runtime, type Serving } from "@btravstack/core";
import { Module, Port, Provider } from "@btravstack/di";
import { Ok, OkAsync } from "unthrown";

class Greeter extends Port("Greeter")<{
  readonly greet: (name: string) => string;
}> {}

const ticker: Runtime<typeof Greeter> = {
  name: "ticker",
  resolves: [Greeter],
  start: (host) => {
    const timer = setInterval(() => {
      // Every piece of work goes through `host.run`: that is what makes it
      // count towards the drain, and what gives it an `AbortSignal`.
      void host
        .run({ kind: "tick", id: `${Date.now()}` }, (ctx, signal) =>
          signal.aborted ? Ok("") : Ok(ctx.get(Greeter).greet("world")),
        )
        .tapFailure((failure) => {
          process.stderr.write(`${JSON.stringify({ tick: failure.tag })}\n`);
        });
    }, 1_000);

    const serving: Serving = {
      drain: () => {
        clearInterval(timer);
        return OkAsync();
      },
      stop: () => OkAsync(),
    };

    return OkAsync(serving);
  },
};

class Ticker extends RuntimePort<Runtime<typeof Greeter>> {}

const TickerModule = Module("Ticker")({
  provides: [Provider(Ticker)({ value: ticker })],
  exports: [Ticker],
});
```

A composition root that imports `TickerModule` must also export `Greeter`, or
`start` refuses the module against
`"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.
