---
"@btravstack/core": minor
"@btravstack/testing": minor
---

The application kernel: `start` boots a `@btravstack/di` module into a running
process with one runtime, drains in-flight work on SIGTERM, and closes the
application scope on every path.

- `start(module, options)` returns a `RunningApp` — `exited`
  (`AsyncResult<ExitReport, E | RuntimeStartFailed>`, the module's own error
  type passed through unwrapped), `stop`, `requestDrain`, `phase`, `ready`,
  `probePort` and `runtimeInfo`. It never throws and never calls
  `process.exit`. The runtime's
  declared `needs` are checked against the module's exports at compile time.
- The `Runtime` / `RuntimeHost` / `RunUnit` / `Serving` contract, with unit
  tracking owned by the kernel: `Serving.drain(signal)` returns
  `AsyncResult<void, never>` and the kernel does the accounting into a
  `DrainReport`.
- A channel for what a runtime **is**: `Serving.info` publishes arbitrary
  structured info about a serving runtime, and `RunningApp.runtimeInfo()` reads
  it back as an `AsyncResult<Info | undefined, never>` that settles when the
  runtime starts serving — so a runtime binding an ephemeral `port: 0` tells the
  caller which port it got instead of inventing an `onListening` hook. The shape
  is the runtime's own (a queue runtime has no port), and `Info` defaults to
  `never`, so publishing is optional with no extra ceremony.
- A three-beat drain — readiness false, `preDrainDelayMs` before the runtime
  stops accepting, then `drainTimeoutMs` for in-flight work — plus liveness and
  readiness probes served from the lifecycle state machine rather than a
  transport.
- `runMain`, which turns an outcome into a process exit code (`0` / `1` / `2` /
  `70`) by setting `process.exitCode`.
- `currentUnit()` over an `AsyncLocalStorage` record carrying
  `{ unitId, traceId, tenantId, deadline, signal }` — data, never capabilities.
- A `@btravstack/testing` package with `testRuntime`,
  `createFakeClock` and `withApp`.
- **Every async API returns an `AsyncResult`, never a bare `Promise`** — the
  infallible ones included, where `AsyncResult<T, never>` spells "async, and
  cannot fail". `probePort()`, `Clock.sleep`, `FakeClock.advance`,
  `UnitRegistry.awaitIdle`, `TestRuntime.untilStarted` and `ProbeServer.close`
  all carry `E = never`. Three surfaces are deliberately outside it: `runMain`
  (the boundary out of the Result world, into a process exit code), `UnitWork`'s
  `Promise<Result<T, E>>` arm (it accepts a caller's `async` handler) and
  `withApp`/`use` (a thrown assertion inside a test body must reach the test
  runner, which an `AsyncResult` — which never rejects — would swallow).
