---
title: RunningApp
description: The handle start returns — exited, stop, requestDrain, phase, ready, probePort and runtimeInfo — with what each resolves and when, plus the Phase union.
---

<!-- doctest: prelude
import { TestRuntimePort } from "@btravstack/testing";
import { Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
declare const OrderApi: Module<InstanceType<typeof TestRuntimePort>, never, Env | Scope>;
declare const RequestModule: Module<never, never, never>;
import { start, type ExitReport, type RunningApp } from "@btravstack/core";
import type { AsyncResult } from "unthrown";
-->

# `RunningApp`

> **Reference.** The handle `start` returns: every member, what it resolves,
> and when. For how to obtain one, see [start](/reference/core/start); for what
> `exited` carries, see [ExitReport and DrainReport](/reference/core/exit-report);
> for embedding it in a host of your own, see
> [Embed without runMain](/how-to/embed-without-run-main).

## The type

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type RunningApp<E, Info = never> = {
  readonly exited: AsyncResult<ExitReport, E | RuntimeStartFailed>;
  readonly stop: () => void;
  readonly requestDrain: () => void;
  readonly phase: () => Phase;
  readonly ready: () => boolean;
  readonly probePort: () => AsyncResult<number | undefined, never>;
  readonly runtimeInfo: () => AsyncResult<Info | undefined, never>;
};
```

`E` is the module's own error type; `Info` is `RuntimeInfoOf<X>`, whatever the
module's runtime publishes on `Serving.info` (`never` when it publishes
nothing).

## Members

| Member           | Returns                                            | Semantics                                                                                                                                                                                                                                                                                                              |
| ---------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `exited`         | `AsyncResult<ExitReport, E \| RuntimeStartFailed>` | Settles once the process has stopped: `Ok(report)` when the graph came up and went down again, `Err` when construction failed (`E`) or the runtime or probe server refused to start (`RuntimeStartFailed`), a `Defect` when something unmodeled blew up. It never rejects.                                             |
| `stop()`         | `void`                                             | Requests a shutdown **without draining**: the phase goes straight to `stopping`, in-flight units are aborted at once, `ExitReport.reason` is `"runtimeStopped"` and `drain` is `undefined`. Idempotent; a second request of any kind changes nothing.                                                                  |
| `requestDrain()` | `void`                                             | Requests the **signal** path programmatically: readiness flips false, the pre-drain delay, `Serving.drain`, the deadline — exactly what SIGTERM does. `reason` is `"signal"`. Also idempotent, and it does not act as the "second signal" that skips the drain.                                                        |
| `phase()`        | `Phase`                                            | The current phase, synchronously.                                                                                                                                                                                                                                                                                      |
| `ready()`        | `boolean`                                          | The predicate `/readyz` answers from: `phase() === "serving"` and not forced unready. Readable synchronously because the uncaught path forces it false while the phase is still `"serving"` — a window no HTTP round trip fits inside. It is what an embedder wires into its own health endpoint when `probes: false`. |
| `probePort()`    | `AsyncResult<number \| undefined, never>`          | The port the probe server actually bound, once the bind attempt has settled — before the graph is built. `undefined` when probes are disabled or the bind failed. The point of it is `probes: { port: 0 }`. It can never hang: settled on every route out of the bind.                                                 |
| `runtimeInfo()`  | `AsyncResult<Info \| undefined, never>`            | Whatever the runtime published on `Serving.info`, settled the moment the phase reaches `serving`. `undefined` when the runtime publishes nothing or never reached `serving`. Same shape as `probePort()`, one layer up.                                                                                                |

Only the first shutdown request counts: `stop()`, `requestDrain()`, a signal
and an uncaught exception all settle the same one-shot deferred, and the
`reason` is whichever arrived first.

## `Phase`

<!-- doctest: skip — a signature display, not a program: the surface it quotes is compiled as the package itself -->

```ts
type Phase =
  "building" | "starting" | "serving" | "draining" | "stopping" | "exited";
```

Phases are **strictly ordered** and only ever advance; a request to move
backwards is ignored. Which phase means what:

| Phase      | Entered when                                                                                        | `/livez` | `ready()`                    |
| ---------- | --------------------------------------------------------------------------------------------------- | -------- | ---------------------------- |
| `building` | `start` is called; the probe server binds and `Module.scoped` begins building the graph             | 200      | `false`                      |
| `starting` | the graph is built and `runtime.start(host)` has been called                                        | 200      | `false`                      |
| `serving`  | the runtime answered `Ok(serving)`                                                                  | 200      | `true`, until forced unready |
| `draining` | a signal (or `requestDrain()`) arrived while serving                                                | 200      | `false`                      |
| `stopping` | the drain finished, or `stop()` / an uncaught exception / a startup failure short-circuited to here | 200      | `false`                      |
| `exited`   | `Serving.stop()` settled and the scope is closed, or a startup failure has been reported            | 503      | `false`                      |

A startup failure moves the phase from `building` or `starting` to `stopping`
then `exited` without passing through `serving`, so `phase()` never lies about
an application that has already gone.

## Reading `exited`

```ts
import type { RunningApp } from "@btravstack/core";
import { P } from "unthrown";

const codeOf = async (app: RunningApp<never, unknown>): Promise<number> => {
  const report = await app.exited;

  return report.match({
    ok: (exit) => (exit.reason === "uncaught" ? 70 : 0),
    errCases: (matcher) => matcher.with(P.tag("RuntimeStartFailed"), () => 1),
    defect: () => 70,
  });
};
```

That fold is what `runMain` does in full — see
[runMain and exit codes](/reference/core/exit-codes) — and what an embedder
that will not use `runMain` must do itself, because installing the uncaught
handlers suppresses Node's own default exit code of `1`.

## Reading `probePort()` and `runtimeInfo()`

Both are deferreds that settle exactly once and can be awaited before, during
or after the phase they describe:

```ts
const app = start(OrderApi, { probes: { port: 0 } });

const probePort = await app.probePort(); // Result<number | undefined, never>, before the graph exists
const info = await app.runtimeInfo(); // Result<HttpInfo | undefined, never>, once serving
```

`RunningApp<E, unknown>` is the shape to accept when only `exited` is read —
`Info` is covariant, so an app whose runtime publishes anything at all fits.
