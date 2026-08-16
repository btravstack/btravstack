---
title: Probes
description: The kernel's own liveness and readiness server — /livez and /readyz, PROBE_PORT, probes false and port 0, what each route answers in each phase.
---

# Probes

> **Reference.** The kernel's own liveness and readiness endpoints: routes,
> port, configuration and what each answers when. For the Kubernetes side, see
> [Tune the drain for Kubernetes](/how-to/tune-the-drain-for-kubernetes); for
> the option that configures it, see [start and StartOptions](/reference/core/start).

Liveness and readiness are process-level concerns, not transport-level ones, so
the kernel runs a `node:http` server of its own on a separate port. A Temporal
worker pod with no HTTP runtime still gets probes, and an HTTP runtime never
exposes `/healthz` on the public port.

## Routes

| Route         | `200`                                                  | `503`         | Anything else |
| ------------- | ------------------------------------------------------ | ------------- | ------------- |
| `GET /livez`  | body `ok` — any phase before `exited`                  | `unavailable` | —             |
| `GET /readyz` | body `ready` — phase `serving`, and not forced unready | `unavailable` | —             |
| other paths   | —                                                      | —             | `404`, empty  |

`/readyz` answers from the same predicate `RunningApp.ready()` reads
synchronously. Readiness is a **one-way latch**: forced false by a drain
(before the runtime is told to stop accepting) or by an uncaught exception, it
never returns to `true`.

| Phase      | `/livez` | `/readyz`                   |
| ---------- | -------- | --------------------------- |
| `building` | `200`    | `503`                       |
| `starting` | `200`    | `503`                       |
| `serving`  | `200`    | `200`, until forced unready |
| `draining` | `200`    | `503`                       |
| `stopping` | `200`    | `503`                       |
| `exited`   | `503`    | `503`                       |

There is deliberately **no startup probe**: `/livez` answers `200` from
`building` onward, so a slow-building graph is covered by `/readyz` alone.

## Configuration

| `StartOptions.probes` | Behaviour                                                                                                                                                                                                                                                                        |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset                 | The port is bound from **`PROBE_PORT`** in `StartOptions.env` (default `process.env`), through `Config.port("PROBE_PORT", { default: 9000 })`. The one piece of configuration the kernel binds itself, because the probe server is up before the graph — and its `Env` — exists. |
| `{ port: number }`    | Bind that port. `{ port: 0 }` lets the OS choose; read it back from `RunningApp.probePort()`.                                                                                                                                                                                    |
| `false`               | No probe server. `probePort()` resolves `undefined`. `ready()` still works — it is what an embedder wires into a health endpoint of its own.                                                                                                                                     |

`withApp` from `@btravstack/core/testing` forces `probes: false`; a test that
needs the real server calls `start` directly.

## Binding

- **`127.0.0.1` only.** The probe server is for the kubelet on the same node,
  not the network.
- **`unref`'d.** It never keeps the event loop alive; a process whose runtime
  has stopped exits whether or not a probe agent still holds a keep-alive
  connection.
- **Up before the graph is built**, so `/livez` answers while construction is
  still running. Closed as the phase reaches `exited`, without being awaited —
  a slow close must not delay the exit report.
- Errors emitted after listening (an accept failure such as `EMFILE`) are
  ignored rather than left unhandled, so a fault in the health endpoint cannot
  become an `uncaughtException` that tears the application down.

## Failures

A bind failure is a **startup failure**: it stops the graph being built at all
and lands in `exited` as `Err(RuntimeStartFailed({ runtime: "probes", cause }))`,
with a `startFailed` event first.

| Cause                                                | `RuntimeStartFailed.cause`                                                | `runMain` code |
| ---------------------------------------------------- | ------------------------------------------------------------------------- | -------------- |
| port already in use, permission denied               | Node's `'error'` (`EADDRINUSE`, `EACCES`, …)                              | `1`            |
| `PROBE_PORT` malformed (`abc`, `3.5`, `70000`, `""`) | a `ConfigInvalid` with `port: "probes"` and one issue at `["PROBE_PORT"]` | `78`           |
| `{ port }` outside `0..65535` or not an integer      | Node's `ERR_SOCKET_BAD_PORT`, caught rather than let escape as a defect   | `1`            |

## Reading the bound port

```ts
import { start } from "@btravstack/core";

const app = start(OrderApi, { probes: { port: 0 } });
const port = await app.probePort(); // Result<number | undefined, never>
```

`probePort()` settles on every route out of the bind attempt — bound, disabled
or failed — so it can never hang, and it settles before the graph is built.
