---
title: runMain and exit codes
description: The signature of runMain, the exit-code table (0, 1, 2, 70, 78) with its precedence, and why it sets process.exitCode rather than calling process.exit.
---

<!-- doctest: prelude
import { TestRuntimePort } from "@btravstack/testing";
import { Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
declare const OrderApi: Module<InstanceType<typeof TestRuntimePort>, never, Env | Scope>;
declare const RequestModule: Module<never, never, never>;
import { runMain } from "@btravstack/core";
import type { StartGate, StartOptions } from "@btravstack/core";
-->

# `runMain` and exit codes

> **Reference.** The front door of `@btravstack/core` and the table it turns an
> outcome into. For the handle underneath, see [start](/reference/core/start)
> and [RunningApp](/reference/core/running-app); for what a report carries, see
> [ExitReport and DrainReport](/reference/core/exit-report); for the reasoning,
> see [Nothing throws](/explanation/nothing-throws).

## Signature

<!-- doctest: signature=@btravstack/core -->

```ts
const runMain: <X, E, N, UnitX = never, UnitNeeds = never>(
  module: Module<X, E, N> & StartGate<X, UnitNeeds, N>,
  options?: StartOptions<UnitX, UnitNeeds>,
  exit?: (code: number) => void,
) => Promise<void>;
```

`runMain` is `start` composed with the wait for `exited`, then a fold of the
`Result` into a code. It carries the same phantom marker as `start`, intersected
onto `module` (see
[The gate](/reference/core/start#the-gate-startgate-x-unitneeds-n)), so
`NO RUNTIME — …`, `UNSATISFIED RUNTIME PORTS — …` and
`UNSATISFIED UNIT NEEDS — …` are printed at this call site too.

| Parameter | Default                                  | Semantics                                                                                                                                                                                                                                                           |
| --------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`  | —                                        | The composition root; identical to `start`'s.                                                                                                                                                                                                                       |
| `options` | `{}`                                     | Passed to `start` unchanged.                                                                                                                                                                                                                                        |
| `exit`    | `(code) => { process.exitCode = code; }` | Receives the code. The default **sets `process.exitCode`** and never calls `process.exit()`, so pending output flushes, an embedding host keeps control of its own lifetime, and a test observes the code without ending the run. Injectable for exactly that test. |

It returns a **bare `Promise<void>`** — the one async surface in the package
that is not an `AsyncResult`, deliberately: its whole job is to leave the
`Result` world and become a process exit code. `await runMain(Module)` at the
top of a `main.ts` is the intended shape:

```ts
import { runMain } from "@btravstack/core";

import { OrderApi } from "./order-api.js";
import { RequestModule } from "./request-module.js";

await runMain(OrderApi, { unit: RequestModule });
```

That is the whole of `examples/order-api/src/main.ts`.

## The exit-code table

| Outcome of `exited`                                                                                   | Code | sysexits(3)   |
| ----------------------------------------------------------------------------------------------------- | ---- | ------------- |
| `Ok` — exited cleanly: no crash, nothing abandoned, no teardown error                                 | `0`  |               |
| `Err` — a modeled startup failure (the module's own `E`, or `RuntimeStartFailed`)                     | `1`  |               |
| `Err` — a `ConfigInvalid`, or a `RuntimeStartFailed` whose `cause` is one (the kernel's `PROBE_PORT`) | `78` | `EX_CONFIG`   |
| `Ok` — `drain.abandoned > 0`                                                                          | `2`  |               |
| `Ok` — `teardownErrors` non-empty                                                                     | `2`  |               |
| `Ok` — `reason === "uncaught"`                                                                        | `70` | `EX_SOFTWARE` |
| `Defect` — an unmodeled failure anywhere on the path                                                  | `70` | `EX_SOFTWARE` |

### Precedence

Evaluated in this order on an `Ok` report:

1. **A crash outranks abandoned work.** `reason === "uncaught"` is `70` no
   matter what `drain` or `teardownErrors` say. In practice the uncaught path
   skips the drain, so `drain` is `undefined` there — but the ordering is
   written out rather than left to depend on that.
2. **Unclean is `2`.** Abandoned work **or** a failed finaliser; both are "we
   stopped, but not cleanly", and a pool that could not flush is exactly the
   shutdown an orchestrator must not be told succeeded.
3. Otherwise `0`.

On an `Err`, `78` is chosen when the error is a `ConfigInvalid` (by
`instanceof`) or a `RuntimeStartFailed` carrying one as its `cause`; every
other modeled error is `1`. `78` says the **deployment** is wrong, not the
code — the one startup failure fixed without a rebuild.

Both `70`s are `EX_SOFTWARE`, an internal software error, reached through the
two channels a bug can take: a throw the process caught (`uncaught`) and a
`Defect` the `Result` carried.

## Why `70` exists at all

`start` installs `uncaughtException` and `unhandledRejection` handlers when
`signals` is `true`, and installing either **suppresses Node's own default exit
code of `1`**. A process that uses `start` without `runMain` and sets no exit
code of its own therefore exits `0` after a crash — reporting success to its
orchestrator. `runMain` closes that hole; an embedder that will not use it must
fold `ExitReport.reason` into a code itself, or pass `signals: false` and give
up the signal-driven drain. See [Embed without runMain](/how-to/embed-without-run-main).

## Observing the code in a test

```ts
import { runMain } from "@btravstack/core";

let code: number | undefined;
await runMain(
  OrderApi,
  { env: { PORT: "abc" }, probes: false, signals: false },
  (c) => {
    code = c;
  },
);
// code === 78
```

The third argument replaces the default `exit`, so `process.exitCode` is left
alone.
