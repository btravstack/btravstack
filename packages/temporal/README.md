# @btravstack/temporal

**The Temporal worker starter for
[`@btravstack/core`](https://github.com/btravstack/start): one module
providing the runtime, its configuration and its connection; one unit per
activity attempt; and a drain that releases the kernel at the kernel's
deadline.**

Temporal is the first transport where `Serving.drain(signal)` is a genuine
wait. `worker.shutdown()` stops polling immediately, but `run()` resolves only
once the last in-flight activity has finished — and it settles on Temporal's
own `shutdownForceTime`, not the kernel's `drainTimeoutMs`. An activity that
never finishes would hold `Serving.stop` well past the kernel's deadline unless
the signal is raced against it. That asymmetry with `@btravstack/http`, where closing a
listener is instantaneous and the signal has nothing to escalate to, is why
this is a package rather than per-application code.

## Install

```sh
pnpm add @btravstack/temporal @btravstack/core @btravstack/config @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common \
  @temporal-contract/worker @temporal-contract/contract
```

All nine are peer dependencies — install them. Node `>=20`.

Not yet published: this repository has not cut a release, so there is nothing
on npm to install yet. The command above is what it will be once it has.

## A worked example

```ts
// The application's half: its activities, as a service. `TemporalActivities`
// mints the port — its service the record `declareActivitiesHandler` takes for
// the contract — and hands back di's `Provider(port)` builder; the provider
// closes over the use cases it declares — no `needs`, no context — and carries
// the port as `orderActivities.port` for whoever else names it.
const orderActivities = TemporalActivities(contract)("OrderActivities")(
  [PlaceOrder],
  {
    sync: (place) => ({
      placeOrder: {
        place: (args, { errors }) =>
          place
            .execute(args.orderId, args.quantity)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("DuplicateOrder"), (error) =>
                errors.OrderAlreadyPlaced({ id: error.id }),
              ),
            ),
      },
    }),
  },
);

// The composition root: a di module, plus the contract, the activities
// provider and the workflow source — and nothing else to know.
const OrderWorker = TemporalModule("OrderWorker")({
  contract,
  activities: orderActivities,
  workflows: {
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  },
  imports: [AppModule],
});

await runMain(OrderWorker);
```

`TemporalModule(name)({ contract, activities, workflows, address?, namespace?,
gracePeriod?, forceAfter?, imports?, provides?, exports? })` is
`Module(name)({...})` for a Temporal worker: it imports the starter
(`temporal({ contract, activities: activities.port, workflows, ... })`),
prepends the activities provider to `provides` and `TemporalRuntime` to
`exports`, and hands back **exactly** the module `Module(...)` would have
declared over those augmented lists — so the kernel, `start`'s gate and di's
see nothing new. `activities` is the **provider** (not the port), constrained
on its instance type the way `temporal()` constrains the port: a provider of
anything but the implementations record for `contract` fails to typecheck
there. `TemporalActivities(contract)(name)` is the port-and-provider half of
the same sugar: the first call fixes the contract, the second mints a port
named `name` whose service is that record, and what comes back is di's own
`Provider(port)` — so `(deps, arm)` is any arm with the usual typing, and the
provider carries the port typed (`orderActivities.port`) for a module that
exports it or a provider that depends on it. A hand-declared
`class OrderActivities extends Port("OrderActivities")<ActivitiesOf<typeof contract>> {}`
plus `Provider(OrderActivities)(…)` is the same thing spelled out, and still
works. Everything below is the primitive both delegate to; reach for
`temporal()` directly when the module shape is not the one you want.

`temporal(options)` is a module providing three ports:

- **`TemporalRuntime`** — the runtime, declared over the kernel's `RuntimePort`
  with no needs of its own. Export it, and `start` finds it.
- **`TemporalConfig`** — `{ address, namespace }`, bound from
  `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`) and `TEMPORAL_NAMESPACE`
  (default `default`) in the kernel's `Env`. `address` / `namespace` in the
  options **pin** a field instead of reading it — explicit beats environment
  beats default, per field; a pinned field reads nothing from the environment
  (the declared `Env` need and `ConfigInvalid` stay whatever is pinned — the
  kernel discharges the one, a pinned config never produces the other). A blank variable
  is a `ConfigInvalid`, exit `78` under `runMain`, never a silent default.
- **`TemporalConnection`** — the `NativeConnection`, a **resource** of the
  graph: opened with the scope, closed on every exit path, startup failure
  included. A service that will not answer is a modeled `TemporalUnreachable`
  `{ address, cause }` — exit `1`, an operator can act on it — not a defect.

And it has one **need**: the `activities` port. The starter's runtime provider
depends on it through di, so it is not resolved from a context at the first
attempt — a composition root that forgets the activities provider still owes
the port, and `start` rejects it at the call site (`TemporalModule` provides
it, which is the point of the sugar). The port's service is
constrained at the call site too: `activities: A & ActivitiesPort<A, C>` is
`never` for a port whose service is not the implementations record for
`contract`, so the mismatch is a type error on `temporal(...)`, not a startup
failure.

The starter calls `declareActivitiesHandler` itself, with its unit middleware
in place, **inside** its own error qualifier: a contract it cannot satisfy — an
implementation the contract never declared, one it declares and finds missing
— throws there, and that throw is `Err(RuntimeStartFailed)` like any other
startup failure rather than a `Defect`. The middleware injects nothing: an
activity is a closure over its provider's services, and the ambient
`currentUnit()` record carries the trace id for the adapters that want it.

`workflows` is a `WorkflowSource`: `{ workflowsPath }` for a process that lets
Temporal bundle the module, `{ workflowBundle }` for a spec that built one and
memoised it. `gracePeriod` and `forceAfter` are Temporal's own two clocks, see
below.

## What it owns, and what it declines

It owns the Worker's lifecycle (`Worker.create`, `run()`, `shutdown()`), the
unit boundary around every activity attempt, the connection, the configuration
and the release at the kernel's deadline.

It does **not** map a `Result` to an activity failure. A reader coming from
`@btravstack/http` will expect that asymmetry explained: there, nothing else could decide
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
