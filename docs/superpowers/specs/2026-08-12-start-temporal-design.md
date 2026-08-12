# `@btravstack/start-temporal` — the Temporal worker runtime — Design

**Date:** 2026-08-12, revised 2026-08-13
**Status:** Approved; implementation in progress (see the plan)
**Repo:** `btravstack/start`
**Scope:** the second of the deferred runtime packages, after
`@btravstack/start-http`. `-amqp` is not in this document and carries an
unresolved policy question of its own (see _Out of scope_).

## Purpose

The kernel's `Serving.drain(signal)` hands a runtime an `AbortSignal` and asks it
to stop accepting. For HTTP that signal has nothing to escalate to: closing the
listener is instantaneous. Temporal is the first transport where the drain is a
**genuine wait** — `worker.shutdown()` stops polling immediately, but `run()`
resolves only once the last in-flight activity has finished, and it settles on
**Temporal's own `shutdownForceTime`**, not the kernel's `drainTimeoutMs`.

So an activity that never finishes holds `Serving.stop` well past the kernel's
deadline unless the signal is raced against it. `@temporalio/worker` exposes no
public forced shutdown — `Worker.forceShutdown$` is `protected` and
`Runtime.shutdown()` is process-global — so **"stop waiting" is the only
escalation available**. That is the reason this package is worth building rather
than left to each application.

## The 2026-08-13 revision, and why it matters

The first revision designed **two** integrations: a raw `@temporalio/worker` path
(`asActivities`, wrapping plain implementations) and a `temporal-contract` path
(an `ActivityMiddleware`). **The raw path no longer exists.** This package
integrates through `temporal-contract` only.

That deletion is larger than it looks, and the consequences are recorded because
they were paid for once already:

- **`asActivities` and `ActivityImpl` go**, with their tests and exports.
- **So does the activity-boundary `Result` elimination.** `asActivities` had to
  unwrap `Ok` and throw the cause, because on the raw path nothing else stood
  between the kernel's `AsyncResult` and Temporal — returned as-is, Temporal
  awaits the thenable and hands the workflow a `Result` **object** instead of the
  activity's output (observed: `{ tag: "Ok", value: "hello" }`). On the contract
  path `declareActivitiesHandler` already eliminates the Result, so that boundary
  work leaves with the path that needed it.
- **Decision 5 below is therefore unconditional**, where it used to apply to one
  arm only.

Unchanged: `metaFor`'s task-token policy, the drain's deadline race, and the
finding that `temporal-contract` needs no modification.

## Decisions

1. **Peer on `@temporalio/worker` only.** `temporal-contract` stays a
   **devDependency**: the middleware type is declared structurally in our own
   source, so a consumer who does not use it never sees it in their dependency
   graph. A published peer range of `^8.0.0-beta` would push every consumer onto
   a beta and couple them to a second release cycle.

2. **A factory owns the Worker.** `temporalRuntime(options)` returns a `Runtime`,
   mirroring `httpRuntime`. It surfaces only the options a caller demonstrably
   sets; `Worker.create`'s remaining ~40 are added when someone needs one, on the
   evidence of the 2026-08-12 audit that deleted five never-set options from
   `examples/`.

3. **`drain` races the kernel's deadline and documents the detached worker.** At
   the deadline the kernel gets its thread back and reports the activity
   `abandoned`, while the worker winds down on Temporal's clock until the process
   exits. Closing the `NativeConnection` to force it was rejected: the package did
   not open that connection, and killing an activity mid-write is worse than
   letting it finish unobserved.

4. **One integration, through a middleware.** `temporal-contract` already ships
   `ActivityMiddleware` / `declareActivityMiddleware` / `composeActivityMiddleware`,
   and middleware is exactly the seam a unit-per-attempt boundary needs.

5. **The package does not map `Result` → activity failure.**
   `declareActivitiesHandler` already converts `Err` → `ApplicationFailure` (with
   `nonRetryable` per call) and re-throws an unexpected throw as a defect. A
   second mapping would fight it.

## `temporal-contract` needs no changes

Examined rather than assumed, and recorded so it is not re-derived:

| Property                                                                                                                | Why it matters                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `CreateWorkerOptions` is `Omit<WorkerOptions, "activities" \| "taskQueue"> & { contract }`                              | Already thin — it adds typing, it does not restrict the Worker |
| `declareActivitiesHandler`'s output is **flat**                                                                         | Temporal sees one activity namespace; the record is ordinary   |
| `ActivityMiddleware` is `(invocation, next) => AsyncResult`, and `next({ context })` **augments** what flows downstream | A middleware can open a unit _and_ inject the per-unit context |
| `createContext` is "invoked once per activity execution"                                                                | Per-invocation values are already a supported concept          |

The only thing it does not do is open a kernel unit, which is not its job.

## Public surface

```ts
export type TemporalInfo = {
  readonly taskQueue: string;
  readonly namespace: string;
};

export type TemporalOptions<Needs extends AnyPort> = {
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly namespace?: string;
  readonly workflows:
    | { readonly workflowsPath: string }
    | { readonly workflowBundle: WorkflowBundleWithSourceMap };
  readonly activities: (
    host: RuntimeHost<Needs>,
  ) => Record<string, (...args: never[]) => unknown>;
  readonly needs: readonly Needs[];
  readonly forceAfter?: Duration;
  readonly gracePeriod?: Duration;
};

export const temporalRuntime: <Needs extends AnyPort>(
  options: TemporalOptions<Needs>,
) => Runtime<Needs, TemporalInfo>;

export const activityUnits: <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
) => ActivityMiddleware<Needs>;
```

- **`activities` is built from the host**, because the middleware needs `host` and
  `host` only exists once the runtime starts. In practice it returns
  `declareActivitiesHandler({ contract, middleware: [activityUnits(host)], … })`,
  whose flat output is what Temporal expects.
- **`ActivityMiddleware<Needs>` is our own structural declaration** of
  `temporal-contract`'s shape, not an import. That is what keeps the type
  dependency one-way and the peer range clean.
- **`namespace` defaults to `"default"`; `forceAfter` to `15 seconds`;
  `gracePeriod` to `10 seconds`.**

**`forceAfter` and `gracePeriod` are real options here** although the identical
options were deleted from `examples/order-temporal` on 2026-08-12 for never being
set. The package boundary is the difference: it cannot see the kernel's
`drainTimeoutMs`, so a hardcoded force-time is only correct against the default
`20_000`, and a caller who raises `drainTimeoutMs` to 60 s would have activities
killed at 15 s by a constant they cannot reach.

## The integration

```ts
start(AppModule, {
  runtime: temporalRuntime({
    connection,
    taskQueue: contract.taskQueue,
    needs: [PlaceOrder, Logger],
    workflows: { workflowsPath },
    activities: (host) =>
      declareActivitiesHandler({
        contract,
        middleware: [activityUnits(host)],
        activities: {
          placeOrder: {
            place: (args, { context }) =>
              context.ctx.get(PlaceOrder).execute(args.orderId, args.quantity),
          },
        },
      }),
  }),
});
```

One line — the middleware — is what a `temporal-contract` user adds. Everything
else is what they already write.

## The unit boundary

One unit per activity **attempt**, never per workflow execution. Workflows run in
a deterministic sandbox with no DI access and are replayed; they are registered
and otherwise left alone.

`UnitMeta` is minted by the package, no knobs, as `-http` does:

| Field     | Value                                                | Why                                                                                                                                                            |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`    | `"activity"`                                         | The category                                                                                                                                                   |
| `id`      | Temporal's **task token**                            | Unique per attempt — a workflow id is not: an activity is retried under the same execution, and Temporal lets a workflow id be reused once an execution closes |
| `traceId` | the **workflow id**, falling back to the activity id | The correlation id, minted outside this process, steady across retries so all attempts join up in a log                                                        |

Both come from `activityInfo()`. This discharges the kernel's second unenforceable
contract on the caller's behalf: a caller cannot pass a category as the id,
because it cannot pass an id at all.

The middleware calls `host.run(metaFor(), (ctx) => next({ context: { ctx } }))`,
so the context arrives through `temporal-contract`'s own per-invocation channel —
which means the deferred per-unit `forkScope` lands later without an API change.

## Lifecycle

```
start(host)
  ├─ Worker.create({ connection, namespace, taskQueue, …workflows,
  │                  activities: options.activities(host),
  │                  shutdownGraceTime, shutdownForceTime })
  │     wrapped in fromPromise with a qualifier, so a bundle that will not build
  │     is Err(RuntimeStartFailed{ runtime: "temporal" }) and never a Defect
  └─ poll: `running = fromSafePromise(worker.run())`  — HELD, never dropped

drain(signal)   deadline = signal; stopPolling(); return releasedBy(deadline, running)
stop()          stopPolling(); return releasedBy(deadline, running)
```

Three details must carry their reasoning in the code, because each is a line a
later reader would "simplify":

- **`run()` moves the worker to RUNNING synchronously**, before its first await,
  so `stopPolling` can trust `getState()`.
- **`shutdown()` on a non-RUNNING worker throws `IllegalStateError`**, and both
  `drain` and `stop` reach it — on the signal path `stop` always runs after
  `drain` already shut the worker down. Hence the `getState() === "RUNNING"` guard.
- **The deadline is kept from `drain` so `stop` is released by the same abort.**
  Otherwise `finish` calling `stop()` after a timed-out drain starts waiting on
  `running` again, putting `shutdownForceTime` back in charge of the exit.

## Error handling

| Failure                                                            | Channel                                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Bundle will not compile, connection refused, worker will not start | `Err(RuntimeStartFailed{ runtime: "temporal", cause })`              |
| An activity's own `Err`                                            | The caller's, via `declareActivitiesHandler`. **Not the package's.** |
| An activity's `Defect`                                             | Propagates; Temporal's retry policy owns it                          |
| `run()` defects while polling                                      | Held on `running` and handed to the kernel by `drain`/`stop`         |

## Testing

All five test conventions bind. Coverage at 100% lines and functions, enabled in
the task that makes them satisfiable — not before, per the `-http` lesson.

The suite runs a real `@temporalio/worker` against `@temporalio/testing`'s
**time-skipping test server** — a 64 MB local binary, not a container — so the
whole Workflow-Task / Activity-Task loop is exercised with **no Docker**. Cached
at `<repo>/.cache/temporal-test-server` with `ttl: "365d"`.

| Test                                                                 | Why it is load-bearing                                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| An activity attempt is one unit, counted in flight                   | The central claim                                                                                                               |
| The unit's `id` is the task token, `traceId` the workflow id         | Both halves of the second unenforceable contract; asserted through a host proxy, since `currentUnit()` cannot see `UnitMeta.id` |
| The middleware injects `ctx` into the implementation                 | The seam, and what makes it cost one line                                                                                       |
| An in-flight activity finishes when the drain has time               | Kernel invariant #2 through a real transport                                                                                    |
| A hung activity is released at the kernel's deadline, not Temporal's | The reason this package exists                                                                                                  |
| `stop()` after a timed-out drain does not re-wait                    | The `deadline` retention detail                                                                                                 |
| A bundle that will not build is `Err`, not a defect                  | The declared error channel                                                                                                      |
| `{ taskQueue, namespace }` on `Serving.info`                         | Why `info` exists                                                                                                               |

## Package layout

```
packages/start-temporal/
  src/temporal-runtime.ts   build / poll / drain / stop
  src/activity-units.ts     metaFor + the activityUnits middleware
  src/index.ts              the public surface
  src/test-workflows.ts     workflows the suite bundles
  src/test-fixtures.ts      time-skipping env, the extended `it`
  README.md
  LICENSE
```

Peers: `@temporalio/worker`, `@temporalio/common`, `@temporalio/activity`, plus
`@btravstack/start`, `@btravstack/di`, `unthrown`. Dev only:
`@temporalio/testing`, `@temporalio/client`, `@temporalio/workflow`, and
**`@temporal-contract/worker`**. No runtime dependencies. `engines: ">=20"`,
`files: ["dist"]`, `sideEffects: false`, dual CJS/ESM via tsdown,
`declarationMap: false`, and a `LICENSE` copied from the siblings.

## Out of scope

A raw `@temporalio/worker` integration (removed 2026-08-13; revisit only if
someone actually wants one), `@btravstack/start-amqp`, workflow-only workers as a
distinct mode, interceptors, sinks, concurrency tuning, and `Result` → activity
failure mapping.

`-amqp` additionally needs a decision this repo has not taken:
`@amqp-contract/testing` hard-depends on `testcontainers`, so a real-broker suite
would put **Docker in the gate** for the first time — against a constraint
`order-infrastructure` and `order-temporal` were both shaped to honour.
