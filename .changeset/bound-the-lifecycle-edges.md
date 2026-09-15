---
"@btravstack/core": minor
"@btravstack/observability": patch
"@btravstack/testing": patch
---

Bound the two lifecycle phases that had no deadline, so a shutdown always
produces its exit report.

`stopTimeoutMs` / `STOP_TIMEOUT_MS` (default `5_000`) bounds `stopping` —
`Serving.stop` **and** the application scope's finalisers — and a crash or a
second signal before the runtime serves abandons the build. Either reports
`ExitReport.abandonedAt` (`"stop" | "build"`), emits a new `stoppedWaiting`
kernel event, and exits `2` under `runMain`. Previously a `release` that never
settled left the process in `stopping` with no event, no exit code and no
report, and an uncaught exception mid-build was absorbed entirely.

It stops waiting rather than cancelling: a wedged finaliser can still hold the
event loop until SIGKILL, but the report now exists and names the phase. The
three shutdown timings sum to the Kubernetes grace-period default of 30 s.

`@btravstack/observability`'s `kernelEvents` logs the new event at `warn` with
`phase` and `afterMs` as fields; `@btravstack/testing`'s `bootFixture` puts the
new deadline out of reach so a spec advancing a fake clock through a drain is
unaffected.
