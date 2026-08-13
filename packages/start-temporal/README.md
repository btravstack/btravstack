# @btravstack/start-temporal

**The Temporal worker runtime for
[`@btravstack/start`](https://github.com/btravstack/start): one unit per
activity attempt, and a drain that releases the kernel at the kernel's
deadline.**

Temporal is the first transport where `Serving.drain(signal)` is a genuine
wait. `worker.shutdown()` stops polling immediately, but `run()` resolves only
once the last in-flight activity has finished — and it settles on Temporal's
own `shutdownForceTime`, not the kernel's `drainTimeoutMs`. An activity that
never finishes would hold `Serving.stop` well past the kernel's deadline unless
the signal is raced against it. That asymmetry with `-http`, where closing a
listener is instantaneous and the signal has nothing to escalate to, is why
this is a package rather than per-application code.

## Install

```sh
pnpm add @btravstack/start-temporal @btravstack/start @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common
```

All six are peer dependencies — install them. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A worked example

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
        middleware: activityUnits<typeof PlaceOrder | typeof Logger>(host),
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

One line — the middleware — is what a
[`temporal-contract`](https://github.com/btravstack/temporal-contract) user
adds. `temporal-contract` is **not** a peer dependency of this package: the
middleware type is declared structurally in this package's own source, so a
consumer who does not use it never sees it in their dependency graph.

`activities` is a builder rather than a finished record because `activityUnits`
needs the `RuntimeHost` to open units against, and the host does not exist
until `start` calls the runtime. The package never wraps what the builder
returns, which is what makes double-wrapping impossible rather than something
to detect.

**Pass the type argument** to `activityUnits` — or hoist the call into a
`const` — whenever an implementation reads `context.ctx`. TypeScript infers the
injected context from the middleware's own type and infers nothing from a
generic call it is still resolving, so `activityUnits(host)` written bare and
inline leaves `context` empty inside the implementations.

## What it owns, and what it declines

It owns the Worker's lifecycle (`Worker.create`, `run()`, `shutdown()`), the
unit boundary around every activity attempt, and the release at the kernel's
deadline.

It does **not** map a `Result` to an activity failure. A reader coming from
`-http` will expect that asymmetry explained: there, nothing else could decide
`404` or `500`, and the package still declines to. Here
`declareActivitiesHandler` already owns the mapping — a declared contract error
becomes a `nonRetryable` `ApplicationFailure` the workflow can branch on, and
anything unmodelled is retried by the platform's own policy. Doing it twice is
what the removal of this package's raw-worker path was about.

## The drain, and the worker that keeps winding down

`Serving.drain(signal)` calls `worker.shutdown()` — polling stops at once,
in-flight activities run to completion — and then waits on `run()` **raced
against the kernel's deadline signal**.

When the deadline wins, the runtime returns and the worker is still alive.
`@temporalio/worker` exposes no public forced shutdown (`Worker.forceShutdown$`
is `protected`, `Runtime.shutdown()` is process-global), so "stop waiting" is
the only escalation available: the kernel gets its thread back on time, reports
the activity `abandoned`, and the worker keeps winding down on Temporal's own
clock until the process exits. This is the package's one surprising behaviour.

`stop()` is released by the same signal, kept from `drain`. Without that, the
release would be half done — the kernel calls `stop()` after a drain that has
already timed out, and a `stop` that began waiting on `run()` all over again
would put `shutdownForceTime` back in charge of when the process exits.

## `forceAfter` and `gracePeriod`

`forceAfter` is Temporal's `shutdownForceTime` (default `15 seconds`) and
`gracePeriod` its `shutdownGraceTime` (default `10 seconds`). Keep `forceAfter`
at or below the kernel's `drainTimeoutMs`, whose default is `20_000`: that is
what lets the worker finish forcing itself down before the kernel gives up on
it, and it matters most on the `stop()`-only path, where no kernel deadline is
in play and Temporal's clock alone decides when `Serving.stop` returns.

The package cannot do that for you — `drainTimeoutMs` is a `StartOptions` field
the application passes to `start`, and a runtime is handed neither it nor the
clock it is measured on.

## The unit boundary

One unit per **attempt**, not per execution. `UnitMeta.id` is Temporal's
base64 task token and `traceId` is the workflow id.

A workflow id would be wrong as the `id`, twice over: an activity is retried
under the same execution, and Temporal lets a workflow id be reused once an
execution has closed. A task token identifies one activity task attempt, so its
uniqueness is Temporal's guarantee rather than an argument of ours. The
workflow id is the correlation id — minted outside this process, stable across
every retry — which is exactly what `traceId` is for. An activity with no
workflow falls back to the activity id.

## Writing a runtime

Two contracts a runtime owes the kernel, neither of them checkable, both
discharged here:

1. **The response must be flushed inside the unit.** An activity's result
   leaves the process when `declareActivitiesHandler` resolves the wrapped
   activity, which happens inside `next()` — inside the unit the middleware
   opened. There is no seam for a late write.
2. **`UnitMeta.id` must be unique per unit unless a `traceId` is supplied.**
   Both are minted here, from Temporal's own identifiers, so a caller cannot
   get it wrong by supplying a category where an identity was wanted.

## License

MIT
