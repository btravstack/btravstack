---
title: Embed without runMain
description: Use start directly for a RunningApp handle, fold ExitReport into an exit code yourself, and avoid the silent exit 0 after a crash.
---

<!-- doctest: prelude
import { TestRuntimePort } from "@btravstack/testing";
import { Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
declare const TickerApp: Module<InstanceType<typeof TestRuntimePort>, never, Env | Scope>;
-->

# Embed without `runMain`

> **How-to.** Boot with `start` when you want the `RunningApp` itself — a dev
> runner, a test, a host that owns the process — and decide the exit code
> yourself. For _why_ `runMain` is the one place a process's fate is decided,
> see [Nothing throws](/explanation/nothing-throws); for the handle's surface,
> see [RunningApp](/reference/core/running-app).

`runMain(module, options?)` is `start` composed with the wait for `exited` and
an exit-code table. Everything it does you can do by hand — with one trap you
must close yourself.

## The handle

`start(module, options?)` returns immediately with a
`RunningApp<E, RuntimeInfoOf<X>>`; nothing about the process is decided.

| Member           | What it is                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `exited`         | `AsyncResult<ExitReport, E \| RuntimeStartFailed>` — settles once the application scope has closed |
| `stop()`         | exit **without** draining (`reason: "runtimeStopped"`)                                             |
| `requestDrain()` | the programmatic SIGTERM: drain, then exit (`reason: "signal"`)                                    |
| `phase()`        | `"building" \| "starting" \| "serving" \| "draining" \| "stopping" \| "exited"`                    |
| `ready()`        | the `/readyz` predicate, readable synchronously                                                    |
| `probePort()`    | `AsyncResult<number \| undefined, never>` — the probe port actually bound                          |
| `runtimeInfo()`  | `AsyncResult<Info \| undefined, never>` — whatever the runtime published on `Serving.info`         |

`E` is the module's own error type, unwrapped: a `ConfigInvalid` from a config
provider arrives on `exited` still typed. `RuntimeStartFailed` is the one error
the kernel adds (a port in use, a broker down, a bad `PROBE_PORT`).

## The trap: a crash exits `0`

`start` installs `uncaughtException` and `unhandledRejection` handlers, so it
can mark the process unready and stop it. **Installing either suppresses Node's
default exit code of `1`.** An embedder that awaits `exited`, sets no exit code
and returns therefore exits `0` after a crash — the process reports success to
its orchestrator.

Two ways out:

- **Fold `ExitReport.reason` into a code yourself**, mapping `"uncaught"` to a
  non-zero code (below).
- **Pass `signals: false`**, which turns off the uncaught handlers _and_ the
  SIGTERM/SIGINT handlers together — Node's own `1` comes back, at the cost of
  no signal-driven drain. You then call `requestDrain()` from your own handler.

## Fold `ExitReport` into an exit code

Mirror `runMain`'s table so an operator reads the same codes from every
process:

| Outcome                                                            | Code |
| ------------------------------------------------------------------ | ---- |
| exited cleanly                                                     | `0`  |
| startup failure (a modeled `Err`)                                  | `1`  |
| a `ConfigInvalid`, directly or as a `RuntimeStartFailed`'s `cause` | `78` |
| drained with work abandoned, **or** exited with `teardownErrors`   | `2`  |
| stopped by an uncaught exception or unhandled rejection            | `70` |
| a defect                                                           | `70` |

A crash outranks abandoned work; `70` is sysexits(3)'s `EX_SOFTWARE`, `78` its
`EX_CONFIG`.

```ts
import { start, type ExitReport } from "@btravstack/core";
import { P } from "unthrown";

const codeFor = (report: ExitReport): number => {
  if (report.reason === "uncaught") return 70;
  const unclean =
    (report.drain?.abandoned ?? 0) > 0 || report.teardownErrors.length > 0;
  return unclean ? 2 : 0;
};

const embed = async (): Promise<void> => {
  const app = start(TickerApp);
  const report = await app.exited;

  process.exitCode = report.match({
    ok: codeFor,
    errCases: (matcher) => matcher.with(P.tag("RuntimeStartFailed"), () => 1),
    defect: () => 70,
  });
};
```

`TickerApp` here exports no config port, so `E` is `RuntimeStartFailed` alone
and the one arm is exhaustive. A module whose `E` carries `ConfigInvalid` adds
a `P.tag("ConfigInvalid")` arm returning `78` — and a `RuntimeStartFailed`
whose `cause` is a `ConfigInvalid` (the kernel's own `PROBE_PORT`) earns `78`
too, if you want the same fidelity `runMain` has.

Set `process.exitCode`; do not call `process.exit()`. Pending output flushes,
and a host that embeds you keeps control of its own lifetime.

## Boot two applications side by side

Nothing in `start` is a singleton, which is what makes it embeddable: a dev
runner boots the API and the worker in one process, each with its own handle.
Only one of them may own the process's signal handlers, so give both
`signals: false` and fan your own SIGTERM out; only one may own `PROBE_PORT`,
so pin or disable probes per app.

```ts
const sideBySide = async (): Promise<void> => {
  const api = start(TickerApp, { signals: false, probes: { port: 0 } });
  const worker = start(TickerApp, { signals: false, probes: false });

  const ports = {
    api: (await api.probePort()).get(),
    worker: (await worker.probePort()).get(),
  };
  process.stderr.write(`${JSON.stringify(ports)}\n`);

  process.once("SIGTERM", () => {
    api.requestDrain();
    worker.requestDrain();
  });

  await Promise.all([api.exited, worker.exited]);
};
```

With `signals: false` no uncaught handler is installed either, so a crash in
either application exits `1` by Node's own rule — the trap above does not
apply, and the drain is yours to trigger.

## Read back what was bound

`runtimeInfo()` and `probePort()` are the same deferred shape one layer apart:
settled the moment the runtime is serving (or the probe server bound), and with
`undefined` on every route that never got there, so neither can hang. An HTTP
runtime bound to `PORT=0` publishes `{ port }` on `Serving.info`; a queue
consumer publishes its own shape. Both carry `E = never`, so `.get()` is the
whole read — the fixture in `examples/order-api/src/__tests__/test-fixtures.ts` builds
its client origin from exactly that.

## See also

- [runMain and exit codes](/reference/core/exit-codes) — the table this page
  mirrors, and its precedence.
- [RunningApp](/reference/core/running-app) — the handle, complete.
- [Test an application](/how-to/test-an-application) — `bootFixture` and
  which does the start-use-stop dance for a test.
- [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes) —
  `stop()` against `requestDrain()`, and what the drain reports.
