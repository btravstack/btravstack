---
title: The Runtime contract
description: Runtime, RuntimeHost, UnitHost, RunUnit, Serving, RuntimePort and RuntimeStartFailed, the unit-of-work types, currentUnit, Clock — and the three contracts a runtime owes that the kernel cannot check.
---

<!-- doctest: prelude
import type { AsyncResult } from "unthrown";
import type { UnitMeta, UnitRecord, UnitWork } from "@btravstack/core";
-->

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

A `UnitHost.fork` module's own needs are not part of this contract: a `fork`
module is forked over the application context, so its needs are exactly what
a starter's own `needs` channel already asks the composition root to supply,
and di's ordinary `UNSATISFIED DEPENDENCIES` gate is what refuses a root that
does not — the same gate a starter's own `needs: [Logger]` triggers, not a
`Runtime` type parameter.

## `RuntimeHost<Resolves>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type RuntimeHost<Resolves extends AnyPort> = {
  readonly ctx: Context<InstanceType<Resolves>>;
  readonly run: RunUnit<Resolves>;
};
```

`ctx` is the **application** context — the module's exports, never a port a
`fork` module provides, which exists only in the `Context` `fork` hands back.
`run` is the kernel's unit registry, closed over that context.

## `UnitHost<Resolves>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type UnitHost<Resolves extends AnyPort> = {
  readonly ctx: Context<InstanceType<Resolves>>;
  readonly fork: <UnitX, N, Seeded extends AnyPort = never>(
    module: Module<UnitX, never, N> &
      DependencyGate<Exclude<N, InstanceType<Resolves> | InstanceType<Seeded> | Scope>>,
    seed: readonly SeedEntry<Seeded>[],
  ) => AsyncResult<Context<InstanceType<Resolves> | UnitX | InstanceType<Seeded>>, never>;
};
```

What a unit's work callback is handed instead of a bare `Context`: `ctx` is
the same application context `RuntimeHost.ctx` is, and `fork(module, seed)` is
the one way to open the unit's own scope — building `module` over `ctx` plus
`seed` and handing the forked `Context` back. The kernel closes that scope
when the unit settles: inside the registry's unit, so the unit is not counted
closed until the fork's finalisers have run, and inside the unit's ambient
record, so a teardown log line carries the unit's ids. A construction failure
rides the unit's defect path — the caller's `fork(...)` call settles as a
`Defect` rather than hanging. A unit forks once; a second `fork` call is a
defect too, and so is one made after the unit has settled — nothing awaits
that scope's teardown.

The `DependencyGate` intersection is how a seed **subtracts** a need: what the
module still owes (`N`) is checked after the ports the application context
already resolves, the ports `seed` supplies, and `Scope` have been excluded, so
a module needing only a seeded port compiles and one needing a port neither
side supplies is refused at the `fork` call.

## `RunUnit<Resolves>`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type RunUnit<Resolves extends AnyPort> = <T, E>(
  meta: UnitMeta,
  work: (unit: UnitHost<Resolves>, signal: AbortSignal) => ReturnType<UnitWork<T, E>>,
) => AsyncResult<T, E>;
```

Submit one piece of work as a **unit**. The kernel counts it towards the
drain, opens its ambient record, hands it an `AbortSignal` (fired at the drain
deadline, or at once when the drain is skipped — the same object is on the
record as `signal`, for a runtime whose work callback is a library's `next()`)
and gives the work's own
`Result` **straight back** — mapping that outcome to a transport is the
runtime's job. A runtime that wants a per-unit scope calls `unit.fork(...)`
itself, from inside `work`, at the moment it holds the unit's own input.

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
answers it with `runtime: "probes"` when the probe server cannot bind, and
with `runtime: "kernel"` when one of its own variables is malformed —
`PROBE_PORT`, `PRE_DRAIN_DELAY_MS`, `DRAIN_TIMEOUT_MS` — its `cause` then a
`ConfigInvalid` naming every one of them that was wrong.

## `traceIdOfTraceparent`

<!-- doctest: signature=@btravstack/core -->

```ts
const traceIdOfTraceparent: (header: string) => string | undefined;
```

The trace-id field of a W3C `traceparent` header, and nothing else of it. Reach
for it when your runtime carries an inbound trace: `@btravstack/http-server` reads
it off `traceparent` (outranking `x-request-id`) and `@btravstack/amqp-worker` off
the message headers (outranking `messageId`).

**The parent's span id is dropped**, deliberately: `UnitMeta.traceId` is a
correlation id, not a span context, and half-carrying one would suggest a
parent-child edge nothing here maintains. What comes back is `undefined` for
anything the specification calls invalid — a malformed header, an **all-zero
trace id**, an **all-zero parent id** (well-formed, and naming no span), and the
reserved version **`ff`** — so a runtime falls back to whatever it uses when no
trace arrives, rather than adopting one that means nothing.
`@btravstack/http-server` falls back to `x-request-id` and then to the id it
minted; `@btravstack/amqp-worker` falls back to the delivery's `messageId`, then
`correlationId`, then its own. A **higher version** may append fields the
parser has never seen, and those are read rather than refused — version `00`
stays exact.

Pair it with the rule your own headers need: adopt only a **non-blank** inbound
id, because `UnitMeta.traceId` defaults to `meta.id` when it is nullish and
`""` is not.

## `releasedBy`

<!-- doctest: signature=@btravstack/core -->

```ts
const releasedBy: (
  signal: AbortSignal,
  running: AsyncResult<void, never>,
) => AsyncResult<void, never>;
```

`running`, but no later than the kernel's drain deadline. Reach for it in
`Serving.drain` when the work you await settles on **somebody else's clock** —
Temporal's `shutdownForceTime`, a broker library's `close()` — and therefore
cannot honour `signal` itself. Without it, `Serving.stop` can outlive
`drainTimeoutMs` however long that other clock takes.

<!-- doctest: skip — an object-property excerpt, not a statement: the compiled form is `@btravstack/amqp-worker`'s and `@btravstack/temporal-worker`'s own `drain`, which this fence quotes -->

```ts
drain: (signal) => releasedBy(signal, running);
```

**The losing branch's `Result` is dropped**, which is the point rather than an
oversight: once the deadline wins, the kernel has already moved on and the
eventual outcome has no consumer left. What that costs is the runtime's own
business — an un-acked AMQP delivery is redelivered, so abandoning one repeats
work rather than losing it, while a Temporal activity is retried on another
worker.

It is deliberately **`Clock`-agnostic**: there is no duration in it, only a
signal, so it behaves identically under `@btravstack/testing`'s fake clock.
Racing work against a **timeout** is a different primitive and belongs on
[`Clock`](#clock-and-systemclock) — the kernel's own drain uses `clock.sleep`
for exactly that, so a fake clock can control it. The two look alike and must
not be folded together.

## Units of work

<!-- doctest: signature=@btravstack/core -->

```ts
type UnitMeta = {
  readonly kind: string;
  readonly id: string;
  readonly traceId?: string;
  readonly tenantId?: string;
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

<!-- doctest: signature=@btravstack/core -->

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
3. **`RuntimeHost.ctx` is the application context, and a fork's own scope is
   not synchronous with `host.run`.** A port a `fork` module provides reaches
   the runtime only through the `Context` `fork` hands back, and the work
   runs after an `await` once that module's own provider is async — a runtime
   subscribing to an event from inside it must check whether it already fired
   (`@btravstack/http-server` checks `response.closed` for exactly this).

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
        .run({ kind: "tick", id: `${Date.now()}` }, (unit, signal) =>
          signal.aborted ? Ok("") : Ok(unit.ctx.get(Greeter).greet("world")),
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
  provides: [Provider(Ticker)({ inject: {}, value: ticker })],
  exports: [Ticker],
});
```

A composition root that imports `TickerModule` must also export `Greeter`, or
`start` refuses the module against
`"UNSATISFIED RUNTIME PORTS — the runtime resolves a port the module does not export"`.
