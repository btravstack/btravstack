---
title: Tune the drain for Kubernetes
description: Set preDrainDelayMs and drainTimeoutMs against terminationGracePeriodSeconds, wire the probes, and read what the drain reported.
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

> **How-to.** Make a pod stop without dropping requests: size the two drain
> knobs against the grace period, point the probes at the kernel, and read the
> `DrainReport`. For _why_ the drain has three beats, see
> [Draining, in three beats](/explanation/draining-in-three-beats); for every
> option, see [start and StartOptions](/reference/core/start).

The defaults already fit a stock cluster. Change them only when you change the
grace period, and change both together.

## The two knobs

| Option            | Default  | What it governs                                                                                         |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `preDrainDelayMs` | `5_000`  | how long after SIGTERM the kernel keeps **accepting** before it tells the runtime to stop               |
| `drainTimeoutMs`  | `20_000` | how long in-flight units then get to finish; whatever is still open is aborted and reported `abandoned` |

`preDrainDelayMs` looks like a pointless sleep and is not. **Kubernetes endpoint
removal is eventually consistent**: for a moment after SIGTERM, the ingress is
still routing to a pod the API server has already told to stop. A pod that
stops accepting the instant the signal lands rejects that traffic. Readiness
flips `false` synchronously at the first beat; the delay is what closes the
window before the runtime stops listening. It is charged from the moment the
signal was _received_, so a signal that lands mid-build does not pay it twice.

`drainTimeoutMs` sits deliberately under `terminationGracePeriodSeconds`'
default of `30`, leaving headroom for `stopping` (closing the runtime and the
application scope) before SIGKILL. `5 + 20 = 25` seconds, five in hand.

Raise the grace period and raise the drain with it:

```ts
await runMain(OrderApi, { preDrainDelayMs: 10_000, drainTimeoutMs: 40_000 });
```

```yaml
spec:
  terminationGracePeriodSeconds: 60 # > preDrainDelayMs + drainTimeoutMs, with headroom
```

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

The server binds **`127.0.0.1` only**. A kubelet `httpGet` probe connects to
the pod IP, so it cannot reach a loopback-only listener; use an `exec` probe
that runs inside the container instead. `node` is always in a Node image,
`curl` and `wget` are not:

```yaml
containers:
  - name: order-api
    env:
      - name: PROBE_PORT
        value: "9000"
    readinessProbe:
      exec:
        command:
          - node
          - -e
          - "fetch('http://127.0.0.1:9000/readyz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
      periodSeconds: 5
    livenessProbe:
      exec:
        command:
          - node
          - -e
          - "fetch('http://127.0.0.1:9000/livez').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
      periodSeconds: 10
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
