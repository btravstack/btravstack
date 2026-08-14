---
"@btravstack/core": minor
---

Seven shutdown-path fixes found by a full review of the kernel. Five change
observable behaviour.

- **The drain waits for a unit that opens while the runtime is still stopping
  accepting.** `UnitRegistry.awaitIdle()` answers about the registry at the
  instant it is _called_, and beat 3 was calling it in the same tick as
  `Serving.drain(signal)`. A unit opened while `drain` was still resolving was
  therefore never awaited — it was aborted at the deadline and reported
  `abandoned` with the whole `drainTimeoutMs` unspent. It is now sequenced
  behind `drain`. The window is wide for any runtime whose `drain` is a real
  wait, such as an HTTP server closing out keep-alive connections.

- **`stop()` and the uncaught path now abort in-flight units.** Both skip the
  drain, and neither signalled the work it was leaving behind. That contradicted
  the reason `"uncaught"` skips the drain at all — that in-flight work may be
  completing against corrupted state — and let a unit holding a ref'd socket
  keep the event loop alive after the exit report.

- **`runMain` exits `2` when `ExitReport.teardownErrors` is non-empty.**
  Previously a shutdown whose finalisers all failed still exited `0`, reporting
  success to an orchestrator for a shutdown that may have lost data. `2` already
  meant "we stopped, but not cleanly"; a failed finaliser now earns it as much
  as abandoned work does.

- **The pre-drain delay is charged from when the shutdown was requested.** A
  signal arriving mid-build is buffered until the runtime is serving, so the
  full `preDrainDelayMs` was paid _again_ afterwards. Both together can exceed
  `terminationGracePeriodSeconds` and turn a graceful exit into a SIGKILL.

- **An out-of-range or non-integer probe port is a modeled
  `Err(RuntimeStartFailed)`.** `server.listen` validates the port synchronously
  and _throws_ `ERR_SOCKET_BAD_PORT` rather than emitting `'error'`, so it
  escaped as a `Defect` — bypassing the declared error channel and exiting `70`
  where a startup failure exits `1`.

- **`stderrSink` renders an `Error` cause instead of `{}`.** `JSON.stringify`
  skips non-enumerable properties, so `Error.message` and `stack` never
  serialised — leaving `{"type":"uncaught","cause":{}}` as the default crash
  report. A cause it cannot serialise at all now falls back to
  `"[unserialisable]"` rather than throwing, which `safeSink` would swallow,
  losing the event entirely.

- **The probe server keeps an `'error'` listener for its whole life.** The
  bind-failure listener is now replaced rather than merely removed: a
  post-listen `'error'` (an accept failure such as `EMFILE`) had no listener,
  and an unhandled `'error'` throws — which the kernel's own `uncaughtException`
  handler turned into a whole-application teardown over a fault in its health
  endpoint.
