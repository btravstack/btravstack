---
title: Tune the drain for Kubernetes
description: Set PRE_DRAIN_DELAY_MS, DRAIN_TIMEOUT_MS and STOP_TIMEOUT_MS (or their options) against terminationGracePeriodSeconds, wire the probes, and read what the drain reported.
---

<!-- doctest: prelude
import { TestRuntimePort } from "@btravstack/testing";
import { Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
declare const OrderApi: Module<InstanceType<typeof TestRuntimePort>, never, Env | Scope>;
declare const RequestModule: Module<never, never, never>;
import { runMain, start } from "@btravstack/core";
import { createServer } from "node:http";
-->

# Tune the drain for Kubernetes

> **How-to.** Make a pod stop without dropping requests: size the three
> shutdown knobs against the grace period, point the probes at the kernel, and
> read the `DrainReport`. For _why_ the drain has three beats, see
> [Draining, in three beats](/explanation/draining-in-three-beats); for every
> option, see [start and StartOptions](/reference/core/start).

The defaults already fit a stock cluster. Change them only when you change the
grace period, and change them together.

## The three knobs

| Option            | Variable             | Default  | What it governs                                                                                                                   |
| ----------------- | -------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `preDrainDelayMs` | `PRE_DRAIN_DELAY_MS` | `5_000`  | how long after SIGTERM the kernel keeps **accepting** before it tells the runtime to stop                                         |
| `drainTimeoutMs`  | `DRAIN_TIMEOUT_MS`   | `20_000` | how long in-flight units then get to finish; whatever is still open is aborted and reported `abandoned`                           |
| `stopTimeoutMs`   | `STOP_TIMEOUT_MS`    | `5_000`  | how long `Serving.stop` and the scope's finalisers then get; past it the kernel reports `abandonedAt: "stop"` rather than waiting |

**All three are readable from the environment**, and that is the point of this
page: `terminationGracePeriodSeconds` lives in the manifest, so the values it
has to agree with belong beside it rather than compiled into the image. The
defaults sum to it exactly — `5 + 20 + 5 = 30`. The
option **pins** the field — explicit > environment > default, per field — so a
test fixes a timing while the deployment sets its own.

`preDrainDelayMs` looks like a pointless sleep and is not. **Kubernetes endpoint
removal is eventually consistent**: for a moment after SIGTERM, the ingress is
still routing to a pod the API server has already told to stop. A pod that
stops accepting the instant the signal lands rejects that traffic. Readiness
flips `false` synchronously at the first beat; the delay is what closes the
window before the runtime stops listening. It is charged from the moment the
signal was _received_, so a signal that lands mid-build does not pay it twice.

**`stopping` is bounded because the teardown is where a shutdown wedges.** Beat
3's deadline covers in-flight work; a `release` that never settles — a pool
draining to a host that stopped answering — is not work, and until it had a
deadline of its own it left the process in `stopping` with no `exited` event, no
exit code and no exit report: the artefact the whole lifecycle exists to
produce. Past the deadline the kernel reports anyway, with
`ExitReport.abandonedAt: "stop"` and a `stoppedWaiting` line on stderr.

It stops WAITING rather than cancelling: nothing can cancel a finaliser, so a
wedged one can still hold the event loop until SIGKILL. What changes is that
the report exists and names the phase, so `kubectl logs --previous` answers why
instead of ending mid-sentence.

Raise the grace period and raise the three with it — in the same manifest,
which is why they are variables:

```yaml
spec:
  terminationGracePeriodSeconds: 60 # >= PRE_DRAIN_DELAY_MS + DRAIN_TIMEOUT_MS + STOP_TIMEOUT_MS
  containers:
    - name: api
      env:
        - name: PRE_DRAIN_DELAY_MS
          value: "10000"
        - name: DRAIN_TIMEOUT_MS
          value: "40000"
        - name: STOP_TIMEOUT_MS
          value: "10000"
```

Pin them in code instead when the value is a decision rather than a
deployment's — a test, or a runtime whose own shutdown budget they have to
match:

```ts
await runMain(OrderApi, {
  preDrainDelayMs: 10_000,
  drainTimeoutMs: 40_000,
  stopTimeoutMs: 10_000,
});
```

A variable that is not a whole number, or is set but empty, is a
`ConfigInvalid` naming it — a `startFailed` event and exit `78`, together with
any other kernel variable that was wrong, in one report.

::: warning
A `drainTimeoutMs` at or above the grace period turns a graceful exit into a
SIGKILL: the kernel is still waiting for work when the kubelet stops waiting
for the kernel. Whatever was in flight is lost _and_ never reported.
:::

## Point the probes at the kernel

The kernel runs its own `node:http` probe server, separate from the runtime,
so a Temporal worker with no HTTP port gets probes too and an HTTP runtime
never exposes `/healthz` publicly.

| Route         | `200`                                       | `503`         |
| ------------- | ------------------------------------------- | ------------- |
| `GET /livez`  | `ok` — any phase before `exited`            | `unavailable` |
| `GET /readyz` | `ready` — `serving`, and not forced unready | `unavailable` |

The port comes from `PROBE_PORT` in `env` (default `9000`); `probes: { port }`
pins it, `probes: { port: 0 }` lets the OS choose (read it back with
`app.probePort()`), `probes: false` disables it. A bad `PROBE_PORT` is a
startup failure — `RuntimeStartFailed` for `"probes"` with a `ConfigInvalid`
cause, exit code `78` under `runMain`.

The server binds **`0.0.0.0`** by default, from `PROBE_HOST` — `HOST`'s own
default, for `HOST`'s own reason. A kubelet `httpGet` probe connects over the
**pod IP**, so that is what makes the ordinary probe shape work:

```yaml
containers:
  - name: order-api
    env:
      - name: PROBE_PORT
        value: "9000"
    readinessProbe:
      httpGet:
        path: /readyz
        port: 9000
      periodSeconds: 5
    livenessProbe:
      httpGet:
        path: /livez
        port: 9000
      periodSeconds: 10
```

Set `PROBE_HOST=127.0.0.1` where the probe port must not leave the container —
a node whose pod network is shared, or a port you are reusing. Then the
`httpGet` above cannot reach it, and the probe has to run **inside** the
container. `node` is always in a Node image; `curl` and `wget` are not:

```yaml
env:
  - name: PROBE_HOST
    value: "127.0.0.1"
readinessProbe:
  exec:
    command:
      - node
      - -e
      - "fetch('http://127.0.0.1:9000/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
  periodSeconds: 5
```

There is no separate startup probe by design: `/livez` answers `200` from
`building` onward, so a slow-building graph is covered by `/readyz` alone.
Readiness is a one-way latch — once a drain or an uncaught exception forces it
`false`, it never returns to `true`.

With `probes: false` — because the runtime already owns a port you want to
reuse, say — `app.ready()` is the same predicate `/readyz` answers from,
readable synchronously:

```ts
const app = start(OrderApi, { probes: false });
createServer((request, response) => {
  if (request.url === "/readyz")
    response.writeHead(app.ready() ? 200 : 503).end();
  else response.writeHead(404).end();
}).listen(8081);
```

## Read what the drain reported

`ExitReport.drain` is a `DrainReport` when a signal drained the process, and
`undefined` when the drain was skipped:

| Field             | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `inFlightAtStart` | units open when the drain began, sampled synchronously at beat one                                   |
| `completed`       | units that **closed during** the drain — may exceed `inFlightAtStart` if in-flight work spawned more |
| `abandoned`       | units still open at the deadline, aborted — **the field the exit code keys on**                      |

Under `runMain`, `abandoned > 0` exits `2` (so does a non-empty
`teardownErrors`), and the `drained` event carries the same report to stderr.
An orchestrator reading `2` learns the pod stopped, but not cleanly.

## Which paths drain, and which do not

| Trigger                                         | Drains?                                                                                           | `ExitReport.reason` |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------- |
| first SIGTERM / SIGINT, or `app.requestDrain()` | yes                                                                                               | `"signal"`          |
| a **second** SIGTERM / SIGINT                   | cut short — both waits resolve at once, open units are aborted, the report still lands in `drain` | `"signal"`          |
| `app.stop()`                                    | no                                                                                                | `"runtimeStopped"`  |
| an uncaught exception or unhandled rejection    | no — in-flight work is aborted at once                                                            | `"uncaught"`        |

The second signal is the operator's escape hatch (and double Ctrl-C in
development). Skipping the drain is a decision not to _wait_ for in-flight
work, not to leave it running: every open unit is aborted before `stopping`.

Aborted work only stops if something reads the abort. The unit's `AbortSignal`
reaches the work callback as an argument **and** rides the ambient record as
`currentUnit()?.signal` — the same object — which is what lets a
middleware-shaped runtime honour the deadline: a Temporal activity or an AMQP
handler has no parameter to receive one through. See
[Read the ambient unit from an adapter](/how-to/read-the-ambient-unit).
`stop()` is for an embedder that wants out now; `requestDrain()` is the
programmatic SIGTERM.

## See also

- [Draining, in three beats](/explanation/draining-in-three-beats) — the
  reasoning behind the delay and the deadline.
- [Probes](/reference/core/probes) — the probe server, complete.
- [ExitReport and DrainReport](/reference/core/exit-report) and
  [runMain and exit codes](/reference/core/exit-codes) — the report and how it
  becomes a code.
- [Embed without runMain](/how-to/embed-without-run-main) — when you own the
  exit code yourself.
