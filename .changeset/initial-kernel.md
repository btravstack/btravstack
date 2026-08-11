---
"@btravstack/start": minor
---

The application kernel: `start` boots a `@btravstack/di` module into a running
process with one runtime, drains in-flight work on SIGTERM, and closes the
application scope on every path.

- `start(module, options)` returns a `RunningApp` — `exited`
  (`AsyncResult<ExitReport, E | RuntimeStartFailed>`, the module's own error
  type passed through unwrapped), `stop`, `requestDrain`, `phase`, `ready` and
  `probePort`. It never throws and never calls `process.exit`. The runtime's
  declared `needs` are checked against the module's exports at compile time.
- The `Runtime` / `RuntimeHost` / `RunUnit` / `Serving` contract, with unit
  tracking owned by the kernel: `Serving.drain(signal)` returns
  `AsyncResult<void, never>` and the kernel does the accounting into a
  `DrainReport`.
- A three-beat drain — readiness false, `preDrainDelayMs` before the runtime
  stops accepting, then `drainTimeoutMs` for in-flight work — plus liveness and
  readiness probes served from the lifecycle state machine rather than a
  transport.
- `runMain`, which turns an outcome into a process exit code (`0` / `1` / `2` /
  `70`) by setting `process.exitCode`.
- `currentUnit()` over an `AsyncLocalStorage` record carrying
  `{ unitId, traceId, tenantId, deadline }` — data, never capabilities.
- A `@btravstack/start/testing` entry point with `testRuntime`,
  `createFakeClock` and `withApp`.
