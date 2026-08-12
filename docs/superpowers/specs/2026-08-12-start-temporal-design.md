# `@btravstack/start-temporal` — the Temporal worker runtime — Design

**Date:** 2026-08-12
**Status:** Approved, pending implementation plan
**Repo:** `btravstack/start`
**Scope:** the second of the three deferred runtime packages, after
`@btravstack/start-http`. `-amqp` is explicitly **not** in this document and
carries an unresolved policy question of its own (see _Out of scope_).

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
escalation available**. That asymmetry is the reason this package is worth
building rather than left to each application.

`examples/order-temporal` proved the shape. This package generalises it.

## Decisions

Five decisions, each with its alternatives considered. Two of them **reverse
earlier positions in this same design session**, both because the first draft was
written before `temporal-contract`'s API had been read. They are recorded as
reversals rather than quietly corrected, because the reasoning is the useful part.

1. **Peer on `@temporalio/worker` only.** Not on `temporal-contract`. A published
   package whose peer range is `^8.0.0-beta` would push every consumer onto a
   beta and couple them to a second library's release cycle — `temporal-contract`
   is pinned to an exact beta in this repo precisely because its `latest` tag is
   still the 7.x line.

2. **A factory that owns the Worker.** `temporalRuntime(options)` returns a
   `Runtime`, mirroring `httpRuntime`. It surfaces only the options a caller
   demonstrably sets; `Worker.create`'s ~40 remaining options are added when
   someone needs one, on the evidence of the 2026-08-12 audit that deleted five
   never-set options from `examples/`.

3. **`drain` races the kernel's deadline and documents the detached worker.** At
   the deadline the kernel gets its thread back and reports the activity
   `abandoned`, while the worker keeps winding down on Temporal's clock until the
   process exits. The alternative — closing the `NativeConnection` to force it
   down — was rejected: the package did not open that connection and killing an
   activity mid-write is worse than letting it finish unobserved.

4. **~~A separate `-temporal-contract` adapter package.~~ REVERSED — one package
   serves both.** `temporal-contract` already ships an activity **middleware**
   layer (`ActivityMiddleware`, `declareActivityMiddleware`,
   `composeActivityMiddleware`), and middleware is exactly the seam a
   unit-per-attempt boundary needs. An adapter package would have been glue over
   a seam that already exists.

5. **~~The package maps `Result` → activity failure.~~ REVERSED — it does not.**
   `declareActivitiesHandler` already converts `Err` → `ApplicationFailure` (with
   `nonRetryable` per call) and re-throws an unexpected throw as a defect. A
   second mapping in the package would fight it for `temporal-contract` users,
   which is the opposite of the "no extra cost" goal.

## `temporal-contract` needs no changes

This was examined rather than assumed, and the conclusion is recorded here so it
is not re-derived next time. Four properties make it compose already:

| Property                                                                                                                | Why it matters                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `CreateWorkerOptions` is `Omit<WorkerOptions, "activities" \| "taskQueue"> & { contract }`                              | Already thin — it adds typing, it does not restrict the Worker |
| `declareActivitiesHandler`'s output is **flat**                                                                         | Temporal sees one activity namespace; the record is ordinary   |
| `ActivityMiddleware` is `(invocation, next) => AsyncResult`, and `next({ context })` **augments** what flows downstream | A middleware can open a unit _and_ inject the per-unit context |
| `createContext` is "invoked once per activity execution"                                                                | Per-invocation values are already a supported concept          |

The only thing `temporal-contract` does not do is open a kernel unit, which is
not its job.

## Public surface

```ts
export type TemporalInfo = { readonly taskQueue: string; readonly namespace: string };

export type TemporalOptions<Needs extends AnyPort> = {
  readonly connection: NativeConnection;
  readonly taskQueue: string;
  readonly namespace?: string;                    // default "default"
  readonly workflows:
    | { readonly workflowsPath: string }
    | { readonly workflowBundle: WorkflowBundleWithSourceMap };
  /**
   * Activity implementations, keyed by the flat name Temporal sees. The exact
   * arm — plain implementations the package wraps, or pre-wrapped ones — is the
   * Open question below; the record shape is the same either way.
   */
  readonly activities: ActivitiesRecord;
  readonly needs: readonly Needs[];
  /** Temporal's `shutdownForceTime`. Default `15 seconds` — see below. */
  readonly forceAfter?: Duration;
  /** Temporal's `shutdownGraceTime`. Default `10 seconds`. */
  readonly gracePeriod?: Duration;
};

export const temporalRuntime = <Needs extends AnyPort>(
  options: TemporalOptions<Needs>,
): Runtime<Needs, TemporalInfo>;

/**
 * The `temporal-contract` seam: an `ActivityMiddleware` that opens one kernel
 * unit per activity attempt and injects the application context.
 */
export const activityUnits: <Needs extends AnyPort>(
  host: RuntimeHost<Needs>,
) => ActivityMiddleware<EmptyContext, { readonly ctx: Context<InstanceType<Needs>> }>;
```

`activityUnits`' return type is structural — the package declares the shape
itself rather than importing `ActivityMiddleware` from `temporal-contract`, so
the type dependency stays one-way and `temporal-contract` remains absent from the
peer range.

**`forceAfter` and `gracePeriod` are real options here, though the identical
options were deleted from `examples/order-temporal` on 2026-08-12 for never being
set.** The difference is the package boundary. In the example both those numbers
and `drainTimeoutMs` were visible in one repository, so a knob nobody turned was
dead weight. Here the package cannot see the kernel's `drainTimeoutMs`: a
hardcoded `forceAfter` is only correct against the default `20_000`, and a caller
who raises `drainTimeoutMs` to 60 s would have activities killed at 15 s by a
constant they cannot reach. The option is the seam between two clocks in two
packages.

## The two integrations

```ts
// Raw @temporalio/worker. Whether the package wraps these itself or the caller
// applies a helper first is the Open question below — the call site is the same.
temporalRuntime({
  connection, taskQueue: "orders", needs: [PlaceOrder, Logger],
  workflows: { workflowsPath: require.resolve("./workflows") },
  activities: { place: (args) => /* … */ },
});

// temporal-contract — one middleware added, nothing else changes
declareActivitiesHandler({
  contract,
  middleware: [activityUnits(host)],
  activities: {
    placeOrder: {
      place: (args, { context }) => context.ctx.get(PlaceOrder).execute(args.orderId, args.quantity),
    },
  },
});
```

In the second case the caller passes that handler's flat output as `activities`.
Those entries are already unit-wrapped by the middleware, so the package must not
wrap them again — which is precisely the _Open question_ below.

## The unit boundary

One unit per activity **attempt**, never per workflow execution. Workflows run in
a deterministic sandbox with no access to the DI context and are replayed; they
are registered and otherwise left alone.

`UnitMeta` is minted by the package, with the same no-knobs policy `-http` uses:

| Field     | Value                     | Why                                                                            |
| --------- | ------------------------- | ------------------------------------------------------------------------------ |
| `kind`    | `"activity"`              | The category                                                                   |
| `id`      | Temporal's **task token** | Unique per attempt, which is what `id` requires                                |
| `traceId` | the **workflow id**       | The correlation id — deliberately _not_ unique per attempt, which is the point |

Both come from `activityInfo()` in `@temporalio/activity`, exactly as
`examples/order-temporal` does today. This discharges the kernel's second
unenforceable contract on the caller's behalf: a caller cannot pass a category as
the id, because it cannot pass an id at all.

## Lifecycle

```
start(host)
  ├─ Worker.create({ connection, namespace, taskQueue, …workflows,
  │                  activities: <wrapped>, shutdownGraceTime, shutdownForceTime })
  │     a bundle that will not compile, or a service that will not answer,
  │     is Err(RuntimeStartFailed{ runtime: "temporal" }) — never a throw
  └─ poll: `running = worker.run()`  (HELD, never dropped: run() is
           AsyncResult<void, never>, and an empty error channel is not an
           empty defect channel)

drain(signal)   deadline = signal; stopPolling(); return releasedBy(deadline, running)
stop()          stopPolling(); return releasedBy(deadline, running)
```

Three details carry their reasoning into the code, because each is a line a later
reader would "simplify":

- **`run()` moves the worker to RUNNING synchronously**, before its first await,
  so `stopPolling` can trust `getState()`.
- **`shutdown()` on a worker that is not RUNNING throws Temporal's
  `IllegalStateError`**, and both `drain` and `stop` can reach it — on the signal
  path `stop` always runs after `drain` already shut the worker down. Hence the
  `getState() === "RUNNING"` guard.
- **The deadline is kept from `drain` so `stop` is released by the same abort.**
  Without that, `finish` calling `stop()` after the drain timed out would start
  waiting on `running` all over again, putting `shutdownForceTime` back in charge
  of when the process exits.

## Error handling

| Failure                                                            | Channel                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| Bundle will not compile, connection refused, worker will not start | `Err(RuntimeStartFailed{ runtime: "temporal", cause })`                                 |
| An activity's own `Err`                                            | The caller's, via `declareActivitiesHandler` or their own throw. **Not the package's.** |
| An activity's `Defect`                                             | Propagates; Temporal's retry policy owns it                                             |
| `run()` defects while polling                                      | Held on `running` and handed to the kernel by `drain`/`stop`                            |

`TypedWorker.create` reports bundling and connection faults as a **defect**
carrying a `TechnicalError`, not a modeled `Err`. The package converts that to
`Err(RuntimeStartFailed)` with `recoverDefect`, because a runtime that cannot
start is the one error the kernel mints. `examples/order-temporal` already does
this and the shape carries over.

## Testing

New code, so **all five test conventions bind**. Coverage at 100% lines and
functions, matching `packages/start` and `packages/start-http` — enabled in the
task that makes them satisfiable, per the lesson from the `-http` plan.

The suite runs a real `@temporalio/worker` against `@temporalio/testing`'s
**time-skipping test server** — a 64 MB local binary, not a container — so the
whole Workflow-Task / Activity-Task loop is exercised with **no Docker**. The
binary is cached at `<repo>/.cache/temporal-test-server` with `ttl: "365d"`,
exactly as `examples/order-temporal` does; that fixture is the model.

| Test                                                                 | Why it is load-bearing                           |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| An activity attempt is one unit, counted in flight                   | The package's central claim                      |
| The unit's `id` is the task token, `traceId` the workflow id         | Both halves of the second unenforceable contract |
| An in-flight activity finishes when the drain has time               | Kernel invariant #2, through a real transport    |
| A hung activity is released at the kernel's deadline, not Temporal's | The reason this package exists                   |
| `stop()` after a timed-out drain does not re-wait                    | The `deadline` retention detail                  |
| `activityUnits` middleware opens a unit and injects `ctx`            | The `temporal-contract` seam                     |
| A bundle that will not compile is `Err`, not a defect                | The declared error channel                       |
| `{ taskQueue, namespace }` on `Serving.info`                         | Why `info` exists                                |

## Package layout

```
packages/start-temporal/
  src/temporal-runtime.ts   build / poll / drain / stop
  src/activity-units.ts     the middleware seam + UnitMeta policy
  src/index.ts              the public surface
  src/test-fixtures.ts      the extended `it`
  README.md
  LICENSE
```

Two source files rather than one: the middleware is genuinely separable — it is
the only part a `temporal-contract` user touches directly, and it has no
knowledge of the Worker's lifecycle.

Peer dependencies: `@temporalio/worker`, `@temporalio/common`,
`@temporalio/activity`, plus `@btravstack/start`, `@btravstack/di`, `unthrown`.
`@temporalio/testing` is a dev dependency. **No runtime dependencies.**
`engines: ">=20"`, `files: ["dist"]`, `sideEffects: false`, dual CJS/ESM via
tsdown, `declarationMap: false`, and a `LICENSE` copied from the siblings — the
gap `packages/start-http` had to fix mid-plan.

## Open question for the plan

**How the package avoids double-wrapping.** When a caller passes the output of
`declareActivitiesHandler` — already unit-wrapped by the `activityUnits`
middleware — the factory must not wrap it again, or every attempt would open two
nested units and the drain accounting would double-count.

Three candidate resolutions, to be settled in the first task that touches it:
a marker property the middleware sets on the record and the factory checks; an
explicit `activities: { wrapped: … }` discriminated arm; or making
`activityUnits` the _only_ path and having the factory always expect pre-wrapped
activities, with a helper for the raw case. The third is the most likely — it
removes the ambiguity rather than detecting it — but it changes the factory's
surface, so it belongs in the plan rather than being settled here by assertion.

## Out of scope

`@btravstack/start-amqp`, workflow-only workers as a distinct mode (the `workflows`
option already covers registering them; `declareActivitiesHandler`'s `activities`
is optional for the split-deployment pattern), interceptors, sinks, concurrency
tuning, and `Result` → activity-failure mapping.

`-amqp` additionally needs a decision this repo has not taken:
`@amqp-contract/testing` hard-depends on `testcontainers`, so a real-broker suite
would put **Docker in the gate** for the first time — against a constraint
`order-infrastructure` and `order-temporal` have both been shaped to honour.
