---
title: start and StartOptions
description: The signature of start, every StartOptions field with its default, the phantom StartGate and its three arms, and the error channel of the returned RunningApp.
---

# `start` and `StartOptions`

> **Reference.** The entry point of `@btravstack/core`: what `start` accepts,
> every option with its default, the compile-time gate on the module, and what
> comes back. For the handle it returns, see [RunningApp](/reference/core/running-app);
> for the one-call `main.ts`, see [runMain and exit codes](/reference/core/exit-codes);
> for the reasoning, see [One process, one runtime](/explanation/one-process-one-runtime).

## Signature

```ts
const start: <X, E, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, Scope | Env>,
  options?: StartOptions<UnitX, UnitNeeds>,
  ...gate: StartGate<X, UnitNeeds>
) => RunningApp<E, RuntimeInfoOf<X>>;
```

`start` returns **synchronously**, never throws and never calls
`process.exit`. Every failure lands in `RunningApp.exited`, an
`AsyncResult<ExitReport, E | RuntimeStartFailed>`.

### The module

`Module<X, E, Scope | Env>`, not `Module<X, E, never>`. `Needs` sits in a
covariant position on `Module`, so this accepts three kinds of module: one with
no needs, one whose `acquire`/`release` provider adds `Scope` (the need
`Module.scoped` discharges by opening the scope itself), and one whose
configuration reads `Env`, which the kernel provides. A module with any other
unmet need is rejected at the call site, as di's own gate would reject it.

**The runtime is a service of the module.** The module exports a port declared
over `RuntimePort`; `start` builds the graph, resolves that port and drives what
it finds. Every starter ships such a port (`HttpRuntime`, `TemporalRuntime`,
`AmqpRuntime`) and a module providing it; a hand-rolled runtime declares its
own — see [The Runtime contract](/reference/core/runtime).

### `Env` wrapping

The kernel wraps the module in one that also provides `Env` — `options.env`,
default `process.env` — so a configuration provider anywhere in the graph reads
it. If the module already provides `Env` itself (directly or through an
import), it is booted **without** the kernel's copy and its own wins; di refuses
two providers for one port.

### The error channel

`E` is the module's own error type, **unwrapped**: a construction failure (a
`ConfigInvalid`, a repository that could not connect) reaches `exited` still
typed. `RuntimeStartFailed` is the only error the kernel adds — the runtime
refused to start, or the probe server could not bind.

## `StartOptions<UnitX, UnitNeeds>`

| Option            | Type                              | Default       | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | --------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`             | `Environment`                     | `process.env` | The environment the graph is configured from, provided as the `Env` port; also where the kernel reads its own `PROBE_PORT`. A test hands in a record.                                                                                                                                                                                                                                                                                                                         |
| `unit`            | `Module<UnitX, never, UnitNeeds>` | none          | A module **forked around every unit**: built as the unit opens, torn down as it closes, while the unit's ambient record is still open. Its providers may read anything the application context exports. Its error channel is pinned to `never` — a construction failure becomes the unit's defect. A failing unit finaliser is a `teardownError` event only, never an entry in `ExitReport.teardownErrors`. See [Open a per-request scope](/how-to/open-a-per-request-scope). |
| `clock`           | `Clock`                           | `systemClock` | What the drain sleeps against. A test passes `createFakeClock()`.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `signals`         | `boolean`                         | `true`        | Installs the SIGTERM/SIGINT handlers **and** the `uncaughtException`/`unhandledRejection` ones. `false` disables both together.                                                                                                                                                                                                                                                                                                                                               |
| `probes`          | `{ port: number } \| false`       | unset         | Unset, the probe port is bound from `PROBE_PORT` in `env` (default `9000`); `false` disables the probe server; `{ port: 0 }` lets the OS choose. See [Probes](/reference/core/probes).                                                                                                                                                                                                                                                                                        |
| `preDrainDelayMs` | `number`                          | `5_000`       | Beat 2 of the drain: how long the kernel waits after readiness flips false before telling the runtime to stop accepting. Measured from the first signal, so a signal that lands mid-build is not paid twice.                                                                                                                                                                                                                                                                  |
| `drainTimeoutMs`  | `number`                          | `20_000`      | Beat 3: how long in-flight units get to finish once the runtime has been told to stop accepting. Whatever is still open is aborted and reported `abandoned`.                                                                                                                                                                                                                                                                                                                  |
| `onEvent`         | `EventSink`                       | `stderrSink`  | Where the nine kernel events go. A throwing sink is swallowed. See [Kernel events](/reference/core/events).                                                                                                                                                                                                                                                                                                                                                                   |

Two consequences of `unit` worth stating here, since both are silent when
missed. `RuntimeHost.ctx` is the **application** context: a port the unit
module provides exists only inside unit work, and resolving one at runtime
startup is a defect. And with a unit module the work runs only once the fork is
built — after an `await` when a unit provider is async — so a runtime that
subscribes to an event from inside its work must first check whether it has
already fired.

## The gate: `StartGate<X, UnitNeeds>`

The trailing `...gate` rest parameter is a **phantom**: it never carries a
runtime argument. Its type is `[]` when the module is boot-able and a named
error tuple otherwise, so a bad composition fails on arity at the call site.

```ts
type StartGate<X, UnitNeeds = never> = [Extract<X, RuntimeInstance>] extends [
  never,
]
  ? [
      error: "NO RUNTIME",
      hint: "the module exports no port declared over RuntimePort",
    ]
  : [InstanceType<RuntimeNeedsOf<X>>] extends [X]
    ? [Exclude<UnitNeeds, X | Scope | Env>] extends [never]
      ? []
      : [
          error: "UNSATISFIED UNIT NEEDS",
          missing: Exclude<UnitNeeds, X | Scope | Env>,
        ]
    : [
        error: "UNSATISFIED RUNTIME NEEDS",
        missing: Exclude<InstanceType<RuntimeNeedsOf<X>>, X>,
      ];
```

| Arm                         | Fires when                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NO RUNTIME`                | `X` contains no port declared over `RuntimePort`. Every starter's module sugar exports one; a hand-rolled root must export its runtime port.                                   |
| `UNSATISFIED RUNTIME NEEDS` | The runtime's declared `needs` are not all among the module's exports — the **module's alone**, never the unit module's, because `RuntimeHost.ctx` is the application context. |
| `UNSATISFIED UNIT NEEDS`    | The `unit` module's needs are not covered by the module's exports, `Scope` or `Env` — `Module.forkScope`'s gate, stated where the parent is actually known.                    |

`runMain` and `withApp` carry the same tuple. A rest tuple rather than a
conditional type on `module` is deliberate: a conditional on an
inference-bearing parameter makes TypeScript defer that parameter and can
collapse `X` or `E` to `unknown`.

## Reading the runtime back: `RuntimePort` and `RuntimeInfoOf`

`RuntimePort` is `Port("Runtime")`, exported **generic** — no fixed service —
so a runtime package declares its own concrete port over it and every runtime
port is one id at runtime while each carries its own `Needs`/`Info` in the
type. `RuntimeInfoOf<X>` reads the `Info` back out of a module's exports, which
is how `RunningApp<E, RuntimeInfoOf<X>>` types `runtimeInfo()`.

```ts
import { RuntimePort, start, type Runtime } from "@btravstack/core";
import { Module, Provider } from "@btravstack/di";
import { OkAsync } from "unthrown";

type HttpInfo = { readonly port: number };

const httpish: Runtime<never, HttpInfo> = {
  name: "httpish",
  needs: [],
  start: () =>
    OkAsync({
      drain: () => OkAsync(),
      stop: () => OkAsync(),
      info: { port: 8080 },
    }),
};

class Httpish extends RuntimePort<Runtime<never, HttpInfo>> {}

const HttpishApp = Module("HttpishApp")({
  provides: [Provider(Httpish)({ value: httpish })],
  exports: [Httpish],
});

const app = start(HttpishApp, { env: {}, probes: false });
const info = await app.runtimeInfo(); // Result<HttpInfo | undefined, never>
```

Drop `Httpish` from `exports` and the call to `start` fails to compile with
`NO RUNTIME`.

## Lifecycle, in order

1. `building` is emitted and the probe server binds — **before** the graph
   exists, so `/livez` answers while it is still building.
2. `Module.scoped` builds the graph; the phase moves to `starting`; the runtime
   is resolved from `RuntimePort` and `runtime.start(host)` is called.
3. On `Ok(serving)`, the phase moves to `serving`, `Serving.info` settles
   `runtimeInfo()`, and the kernel waits for a shutdown request.
4. A signal drains; `stop()` and an uncaught exception go straight to
   `stopping`. `Serving.stop()` runs, the scope closes, and `exited` settles
   with an [ExitReport](/reference/core/exit-report).

Any failure before step 3 — a construction `Err`, a runtime that refused, a
probe bind failure — emits `startFailed`, moves the phase to `stopping` then
`exited`, and lands in `exited`'s error channel.
