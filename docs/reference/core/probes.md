---
title: Probes
description: The kernel's own liveness and readiness server — /livez and /readyz, PROBE_PORT and PROBE_HOST, probes false and port 0, what each route answers in each phase.
---

<!-- doctest: prelude
import { TestRuntimePort } from "@btravstack/testing";
import { Env } from "@btravstack/config";
import type { Module, Scope } from "@btravstack/di";
declare const OrderApi: Module<InstanceType<typeof TestRuntimePort>, never, Env | Scope>;
declare const RequestModule: Module<never, never, never>;
-->

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

| Route          | `200`                                                      | `503`         | Anything else |
| -------------- | ---------------------------------------------------------- | ------------- | ------------- |
| `GET /livez`   | body `ok` — any phase before `exited`                      | `unavailable` | —             |
| `GET /readyz`  | body `ready` — lifecycle ready and opted-in checks healthy | `unavailable` | —             |
| `GET /healthz` | every declared health check passed                         | the report    | —             |
| other paths    | —                                                          | —             | `404`, empty  |

`RunningApp.ready()` reads the lifecycle predicate synchronously. `/readyz`
additionally evaluates the cached results of checks that opt into readiness.
Dependency failures can recover without a restart. The lifecycle is a one-way
latch: forced false by a drain (before the runtime stops accepting) or an
uncaught exception, it never returns to `true`, even if a check recovers.

| Phase      | `/livez` | `/readyz`                                           |
| ---------- | -------- | --------------------------------------------------- |
| `building` | `200`    | `503`                                               |
| `starting` | `200`    | `503`                                               |
| `serving`  | `200`    | `200` if opted-in checks pass, until forced unready |
| `draining` | `200`    | `503`                                               |
| `stopping` | `200`    | `503`                                               |
| `exited`   | `503`    | `503`                                               |

## `/healthz` — the dependency report

Every module that declares a health check contributes one to the `HealthChecks`
set port; the kernel reads all of them and folds them into one report. The body
is JSON in both the `200` and the `503` case:

```json
{
  "status": "unhealthy",
  "components": [
    { "name": "cache", "status": "healthy" },
    {
      "name": "database",
      "status": "unhealthy",
      "reason": "connection refused"
    }
  ]
}
```

One unhealthy component makes the whole application unhealthy, and the report
still names every component — a report naming only the first failure is worth
less than one naming all of them. An application that composed no starter
declaring a check gets `{"status":"healthy","components":[]}`: a set port with
no contributors is empty, not missing.

Ordinary checks do not gate readiness and run on every `/healthz` request.
Readiness opt-in is for dependencies without which the pod cannot serve, such
as required credentials or keys. A shared dependency failure can remove every
replica from load balancing, so each contribution makes that choice explicitly.

## Gating readiness

Set `readiness: true` on a `HealthCheck` to gate `/readyz`, using a 1000 ms
cache, or set `{ intervalMs }` to choose the cache interval:

<!-- doctest: isolate -->

```ts
import { type HealthCheck } from "@btravstack/core";
import { OkAsync } from "unthrown";

const credentials: HealthCheck = {
  name: "credentials",
  readiness: { intervalMs: 5000 },
  check: () => OkAsync(), // replace with the adapter's credential check
};
```

Contribute the check through `Provider.member(HealthChecks)` and export the set
port from its module, just as for any health check. `false` or omission keeps
the check independent of readiness. The interval must be positive and finite;
an invalid interval reports the component unhealthy without invoking it.

Both `/readyz` and `/healthz` share each opted-in check's cache. Concurrent
probes share one evaluation; the interval starts when that evaluation settles.
Success, failure, defect and timeout reports are cached alike. After expiry,
the next probe evaluates the check again; no background polling runs. Checks
run in parallel and use their existing `timeoutMs` (default 800 ms), so the
first probe or a refresh waits for a bounded report. Set the orchestrator's
probe timeout to accommodate any longer per-check deadline.

`/healthz` still reports every component. `/readyz` evaluates only opted-in
checks while the lifecycle is ready and returns `503` if any is unhealthy,
then `200` after a healthy refresh. It never changes `/livez` or restarts the
process. `RunningApp.ready()` remains a lifecycle-only predicate, including
when probes are disabled.

A buggy check is contained, not amplified: one that throws instead of
answering — or whose `AsyncResult` defects — becomes an unhealthy component
line naming the cause, exactly like a check that failed properly. The request
always gets its response, and the throw never reaches the process's uncaught
handler.

There is deliberately **no startup probe**: `/livez` answers `200` from
`building` onward, so a slow-building graph is covered by `/readyz` alone.

## Configuration

| `StartOptions.probes`             | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unset                             | The port and the interface are bound from **`PROBE_PORT`** and **`PROBE_HOST`** in `StartOptions.env` (default `process.env`), through `Config.port("PROBE_PORT", { default: 9000 })` and `Config.string("PROBE_HOST", { default: "0.0.0.0" })`, alongside the three drain timings. These are the configuration the kernel binds itself, because the probe server is up — and the drain is scheduled — before the graph, and its `Env`, exists. |
| `{ port: number, host?: string }` | Bind that port, on that interface. `{ port: 0 }` lets the OS choose the port; read it back from `RunningApp.probePort()`. An omitted `host` still reads `PROBE_HOST`.                                                                                                                                                                                                                                                                           |
| `false`                           | No probe server, and neither variable is read. `probePort()` resolves `undefined`. `ready()` still works — it is what an embedder wires into a health endpoint of its own.                                                                                                                                                                                                                                                                      |

`@btravstack/testing`'s `bootFixture` defaults to `probes: false`, and its
`bootFixture` defaults to it; a test that needs the real server passes
`boot(module, { probes: { port: 0 } })` or calls `start` directly.

## Binding

- **`0.0.0.0` by default**, which is `HOST`'s own default for `HOST`'s own
  reason: a kubelet `httpGet` probe connects over the **pod IP**, so a
  loopback-only listener cannot answer the one probe shape every manifest
  reaches for first. Set `PROBE_HOST=127.0.0.1` — or pin
  `probes: { port, host: "127.0.0.1" }` — where the port is shared with
  something else on the host, and probe it with `exec` from inside the
  container.
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

| Cause                                                  | `RuntimeStartFailed.cause`                                                                                                                                                         | `runMain` code |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| port already in use, permission denied                 | Node's `'error'` (`EADDRINUSE`, `EACCES`, …)                                                                                                                                       | `1`            |
| `PROBE_PORT` malformed (`abc`, `3.5`, `70000`, `""`)   | a `ConfigInvalid` with `port: "kernel"`, one issue at `["PROBE_PORT"]` — plus an issue for any other kernel variable that is wrong too, since the kernel reads its own in one pass | `78`           |
| `PROBE_HOST` set to an address this host does not have | Node's `'error'` (`EADDRNOTAVAIL`) — the value is a string, so it is the BIND that refuses it rather than the schema                                                               | `1`            |
| `{ port }` outside `0..65535` or not an integer        | Node's `ERR_SOCKET_BAD_PORT`, caught rather than let escape as a defect                                                                                                            | `1`            |

## Reading the bound port

```ts
import { start } from "@btravstack/core";

const app = start(OrderApi, { probes: { port: 0 } });
const port = await app.probePort(); // Result<number | undefined, never>
```

`probePort()` settles on every route out of the bind attempt — bound, disabled
or failed — so it can never hang, and it settles before the graph is built.
