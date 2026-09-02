---
title: ExitReport and DrainReport
description: What exited resolves to — reason, drain, teardownErrors, uptimeMs — and the three counters of a DrainReport, including when drain is undefined and why completed may exceed inFlightAtStart.
---

<!-- doctest: prelude
import type { DrainReport, TeardownError } from "@btravstack/core";
-->

# `ExitReport` and `DrainReport`

> **Reference.** The value `RunningApp.exited` settles with when the
> application came up and went down again. For the handle, see
> [RunningApp](/reference/core/running-app); for how these fields become an
> exit code, see [runMain and exit codes](/reference/core/exit-codes); for the
> three beats behind `drain`, see
> [Draining, in three beats](/explanation/draining-in-three-beats).

## `ExitReport`

<!-- doctest: signature=@btravstack/core -->

```ts
type ExitReport = {
  readonly reason: "signal" | "runtimeStopped" | "uncaught";
  readonly drain: DrainReport | undefined;
  readonly teardownErrors: readonly TeardownError[];
  readonly uptimeMs: number;
};

type TeardownError = { readonly port: string; readonly cause: unknown };
```

| Field            | Semantics                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reason`         | What asked the process to stop. Only the **first** request counts.                                                                                                                                                                                                                                                                |
| `drain`          | The drain's accounting, or `undefined` whenever the drain was skipped.                                                                                                                                                                                                                                                            |
| `teardownErrors` | Every finaliser of the **application scope** that failed as it closed — `port` is the provider's port id, `cause` whatever it threw or answered. A per-unit finaliser (a `StartOptions.unit` module's) is never recorded here; it is emitted as a `teardownError` event only. Under `runMain` a non-empty array is exit code `2`. |
| `uptimeMs`       | `clock.now()` at exit minus `clock.now()` at `start`, on whichever `Clock` the app was started with.                                                                                                                                                                                                                              |

### `reason`

| Value              | Set by                                                                | Drains?                                                                                                           |
| ------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `"signal"`         | SIGTERM, SIGINT, or `app.requestDrain()`                              | **Yes** — the only reason that does.                                                                              |
| `"runtimeStopped"` | `app.stop()`                                                          | No. In-flight units are aborted at once and the phase goes straight to `stopping`.                                |
| `"uncaught"`       | an `uncaughtException` or `unhandledRejection` (with `signals: true`) | No. Draining after a crash risks completing in-flight work against corrupted state, so units are aborted at once. |

`drain` is therefore `undefined` for `"runtimeStopped"` and `"uncaught"`, and
never for `"signal"`: a **second** signal during the drain skips whichever
sleep is pending, but the report still carries a `DrainReport`, with the
counters as sampled at that moment.

::: warning The array is aliased on purpose
`teardownErrors` is the same mutable array the kernel pushes into. di closes
the scope **after** the kernel's `use` callback settles but **before** the
scope's own result settles, so every finaliser failure lands in the array after
the report object is built and before a caller can observe it. Read it once
`exited` has settled, and do not copy it earlier.
:::

## `DrainReport`

<!-- doctest: signature=@btravstack/core -->

```ts
type DrainReport = {
  readonly inFlightAtStart: number;
  readonly completed: number;
  readonly abandoned: number;
};
```

| Field             | Semantics                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inFlightAtStart` | Units open when the drain began — sampled synchronously in the same turn readiness flipped false, **before** the pre-drain delay, so it agrees with the `draining` event emitted from that turn.                                                                                                                                                      |
| `completed`       | Units that **closed during** the drain, counted from a monotonic total, not as `inFlightAtStart - abandoned`. It **may exceed** `inFlightAtStart` when in-flight work spawned more units during the drain — honest reporting, not a bug: the subtraction would go negative the moment a unit started after the sample and closed before the deadline. |
| `abandoned`       | Units still open at the deadline. Each is aborted through its `AbortSignal` and reported here. **The field the exit code keys on**: `> 0` is exit code `2` under `runMain`.                                                                                                                                                                           |

The deadline race is `Serving.drain(signal)` **then** `awaitIdle()`, against
`clock.sleep(drainTimeoutMs)`. `awaitIdle()` is sequenced after `drain`
resolves rather than sampled alongside it, so a unit that opens while the
runtime is still winding down is waited for rather than reported abandoned with
the budget unspent. Whichever branch wins, `signal` is aborted at once, so a
runtime that treats it as its cue to return is always released.

## Reading one

```ts
import type { ExitReport } from "@btravstack/core";

const clean = (report: ExitReport): boolean =>
  report.reason !== "uncaught" &&
  (report.drain?.abandoned ?? 0) === 0 &&
  report.teardownErrors.length === 0;
```

That predicate is the `0` row of `runMain`'s table; every other outcome earns a
non-zero code, in the precedence
[runMain and exit codes](/reference/core/exit-codes) states.
