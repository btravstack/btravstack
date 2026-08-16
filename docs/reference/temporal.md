---
title: "@btravstack/temporal"
description: The Temporal worker starter — TemporalModule, TemporalActivities, temporal(), its three ports, TemporalUnreachable, WorkflowSource, the unit per activity attempt, and the drain raced against the kernel's deadline.
---

# @btravstack/temporal

> **Reference.** A complete, structured description of the Temporal worker
> starter's public surface: every export of `@btravstack/temporal`, its
> options and defaults, and how a worker's drain meets the kernel's deadline.
> For the task, see [Run a Temporal worker](/how-to/run-a-temporal-worker);
> for the reasoning, [Starters](/explanation/starters) and
> [Draining, in three beats](/explanation/draining-in-three-beats); for the
> worked example, [Order Temporal worker](/examples/order-temporal-worker).
> Generated signatures are under [API reference](/api/temporal/).

## Exports

`packages/temporal/src/index.ts` exports exactly this:

| Export                  | Kind  | What it is                                                                                                                                                                                                       |
| ----------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TemporalModule`        | value | `TemporalModule(name)({ contract, activities, workflows, address?, namespace?, gracePeriod?, forceAfter?, imports?, provides?, exports? })` — a di `Module(name)({...})` that also takes the activities provider |
| `TemporalModuleOptions` | type  | The options object `TemporalModule(name)` takes                                                                                                                                                                  |
| `TemporalActivities`    | value | `TemporalActivities(contract)` — di's `Provider(port)` builder on the starter's own activities port, typed for `contract`, so the next call is `(deps, arm)`                                                     |
| `temporal`              | value | `temporal({ contract, workflows, … })` — the starter module itself, needing the activities port for `contract`; what `TemporalModule` imports                                                                    |
| `TemporalOptions`       | type  | `temporal()`'s options                                                                                                                                                                                           |
| `TemporalRuntime`       | value | `class TemporalRuntime extends RuntimePort<Runtime<never, TemporalInfo>> {}` — the runtime's port                                                                                                                |
| `TemporalConfig`        | value | `class TemporalConfig extends Port("TemporalConfig")<{ address: string; namespace: string }> {}` — where the service is, bound from the environment                                                              |
| `TemporalConnection`    | value | `class TemporalConnection extends Port("TemporalConnection")<NativeConnection> {}` — the connection, a resource of the graph                                                                                     |
| `TemporalUnreachable`   | value | `TaggedError("TemporalUnreachable")<{ address: string; cause: unknown }>` — the service did not answer                                                                                                           |
| `TemporalInfo`          | type  | `{ readonly taskQueue: string; readonly namespace: string }` — published on `Serving.info` once polling                                                                                                          |
| `WorkflowSource`        | type  | `{ workflowsPath: string } \| { workflowBundle: WorkflowBundleWithSourceMap }` — where the sandbox's code comes from                                                                                             |

`TemporalActivitiesPort` — `Port("TemporalActivities")`, the starter's own
activities port, declared once — with `ActivitiesPortOf<C>` /
`ActivitiesInstanceOf<C>` (that port's class and instance typed for `C`) and
`ActivitiesOf<C>` (`DeclareActivitiesHandlerOptions<C>["activities"]`, the
implementations record `declareActivitiesHandler` takes, its service) live in
`src/temporal-runtime.ts` and are **not** exported from the entry point: the
port is reached as `provider.port` when a caller needs it, and the types are
inferred at the call.

## `TemporalModule(name)({...})`

Everything `Module(name)({...})` takes, plus the contract, the activities
provider and the workflow source. It appends
`temporal({ contract, workflows, … })` to
`imports`, prepends `activities` to `provides`, prepends `TemporalRuntime` to
`exports`, and hands the augmented tuples to di's own `Module(name)`.

| Option        | Required | Default                        | What it is                                                                                                                                                                                                  |
| ------------- | -------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract`    | yes      | —                              | a `temporal-contract` `ContractDefinition`; the task queue this worker polls is read off it                                                                                                                 |
| `activities`  | yes      | —                              | the activities **provider** — a `Provider<ActivitiesInstanceOf<C>, E, N>`, what `TemporalActivities(contract)(deps, arm)` returns for **this** `contract`; one built for another contract fails at the call |
| `workflows`   | yes      | —                              | a `WorkflowSource`                                                                                                                                                                                          |
| `address`     | no       | read from `TEMPORAL_ADDRESS`   | pins `TemporalConfig.address`                                                                                                                                                                               |
| `namespace`   | no       | read from `TEMPORAL_NAMESPACE` | pins `TemporalConfig.namespace`                                                                                                                                                                             |
| `gracePeriod` | no       | `"10 seconds"`                 | Temporal's `shutdownGraceTime`, a `Duration`                                                                                                                                                                |
| `forceAfter`  | no       | `"15 seconds"`                 | Temporal's `shutdownForceTime`, a `Duration`; keep it at or below the kernel's `drainTimeoutMs`                                                                                                             |
| `imports`     | no       | `[]`                           | the application's modules                                                                                                                                                                                   |
| `provides`    | no       | `[]`                           | the application's own providers                                                                                                                                                                             |
| `exports`     | no       | `[]`                           | the application's own exports; `TemporalRuntime` is added                                                                                                                                                   |

The worked composition root, from
`examples/order-temporal-worker/src/module.ts`:

```ts
export const OrderTemporalWorker = TemporalModule("OrderTemporalWorker")({
  contract: orderContract,
  activities: orderActivities,
  workflows: {
    workflowsPath: workflowsPathFromURL(import.meta.url, "./workflows.js"),
  },
  imports: [ApplicationModule, PersistenceModule, FulfillmentModule],
});
```

## `TemporalActivities(contract)`

The first call fixes `C` (the contract value is otherwise unused; it exists so
`C` is inferred rather than written) and returns `ReturnType<typeof
Provider<ActivitiesPortOf<C>>>` — di's own `Provider(port)` builder on the
starter's activities port, typed for `C` — so the second call is di's `(deps,
arm)` unchanged: any arm, the usual typing, and the provider it returns carries
the port typed as `provider.port`. There is no name to give: a worker serves
one activities record as it polls one task queue, so the port is the starter's
— one `Port("TemporalActivities")`, generic at the value level and fixed per
contract at the type level (`ActivitiesPortOf<C>`, the move the kernel's
`RuntimePort` makes) — and two activities providers in one graph are di's
duplicate-provider defect at build. Each activity is a plain function typed by
the contract (`(args, { errors }) => AsyncResult<…>`), closing over the
services the provider declared; nothing is read from a context.

From `examples/order-temporal-worker/src/activities.ts`:

```ts
export const orderActivities = TemporalActivities(orderContract)(
  [PlaceOrder, OrderRepository, StockService, ShippingService],
  {
    sync: (place, repository, stock, shipping) => ({
      fulfillOrder: {
        place: (args, { errors }) =>
          place
            .execute(args.orderId, args.quantity)
            .map((order) => ({ id: order.id, quantity: order.quantity }))
            .mapErrCases((matcher) =>
              matcher
                .with(P.tag("InvalidQuantity"), (error) =>
                  errors.InvalidQuantity({ id: error.id }),
                )
                .with(P.tag("DuplicateOrder"), (error) =>
                  errors.OrderAlreadyPlaced({ id: error.id }),
                ),
            ),
        reserveStock: (args, { errors }) =>
          stock
            .reserve(args.orderId, args.quantity)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("OutOfStock"), (error) =>
                errors.OutOfStock({ id: error.id }),
              ),
            ),
        arrangeShipping: (args, { errors }) =>
          shipping
            .arrange(args.orderId)
            .mapErrCases((matcher) =>
              matcher.with(P.tag("ShippingUnavailable"), (error) =>
                errors.ShippingUnavailable({ id: error.id }),
              ),
            ),
        releaseStock: (args) => stock.release(args.orderId),
        cancelPlacement: (args) =>
          repository
            .remove(args.orderId)
            .recoverErrCases((matcher) =>
              matcher.with(P.tag("OrderNotFound"), () => undefined),
            ),
      },
    }),
  },
);
```

A hand-written `Provider(orderActivities.port)(…)` targets the same port; a
port declared under any other id leaves the starter's need unmet, and `start`
refuses the module.

## `temporal(options)`

```ts
const temporal: <C extends ContractDefinition>(
  options: TemporalOptions<C>,
) => Module<
  TemporalRuntime | TemporalConfig | TemporalConnection,
  ConfigInvalid | TemporalUnreachable,
  Env | Scope | ActivitiesInstanceOf<C>
>;
```

The primitive `TemporalModule` delegates to. `TemporalOptions<C>` has the
same fields as the sugar minus `activities` / `imports` / `provides` /
`exports`: the activities are not an option but the module's need. It
provides and exports all three ports, and **needs** `Env` (the kernel
discharges it), `Scope` (the connection is a resource; `start` discharges it
too) and the activities port typed for `contract` (`ActivitiesInstanceOf<C>`)
— the runtime provider depends on it through di, so a root that does not
provide it, or provides one built for another contract, is refused at
`start`.

The declared type is the same pinned or not: `Env`, `ConfigInvalid` and
`TemporalUnreachable` stay in the signature whatever is pinned.

## `TemporalConfig`, and the environment

Bound through [`Config.provider`](/reference/config); `address` / `namespace`
in the options pin a field — explicit > environment > default, per field.

| Variable             | Default          | Parsed by       | Notes                                             |
| -------------------- | ---------------- | --------------- | ------------------------------------------------- |
| `TEMPORAL_ADDRESS`   | `127.0.0.1:7233` | `Config.string` | where the service is                              |
| `TEMPORAL_NAMESPACE` | `default`        | `Config.string` | a blank value is a `ConfigInvalid`, not a default |

A malformed value is a `ConfigInvalid` — `startFailed` and exit `78` under
`runMain`.

## `TemporalConnection` and `TemporalUnreachable`

The `NativeConnection` is a **resourceful** provider from `[TemporalConfig]`:
acquired with the scope (`NativeConnection.connect({ address })`) and released
on every exit path, startup failure included. A service that will not answer
is the modeled `TemporalUnreachable { address, cause }` — exit `1` under
`runMain`, a startup `Err` an operator can act on, not the `70` a defect earns.

On release, one refusal is absorbed: `close()` throws `IllegalStateError`
while a Worker still holds the connection, which is exactly the state the
deadline path leaves it in (see the drain below); any other close failure is
still the finaliser's to surface as a `teardownError`.

## `TemporalRuntime` and `TemporalInfo`

Declared over the kernel's `RuntimePort` with service
`Runtime<never, TemporalInfo>` — no needs. Its `start` calls
`declareActivitiesHandler` **inside** the qualified chain (a contract it
cannot satisfy — an undeclared implementation, a declared one missing —
throws there, and that throw becomes `Err(RuntimeStartFailed({ runtime:
"temporal", cause }))`, exit `1`, not a defect), then `Worker.create` with the
connection, `namespace`, `taskQueue`, the workflow source, the wrapped
activities, `shutdownGraceTime` and `shutdownForceTime`. Once `run()` has
started polling it publishes `TemporalInfo`, `{ taskQueue, namespace }`, on
`Serving.info`.

## The unit

One unit per activity **attempt**, `kind: "activity"`, opened by the
starter's own `ActivityMiddleware`, which calls `next()` unchanged — it
injects nothing, and the ambient `currentUnit()` record is what an adapter
reads the trace id from, and the **only** route to the unit's `AbortSignal`
from inside an activity: `currentUnit()?.signal`, aborted at the kernel's
`drainTimeoutMs`. Temporal's `Context.current().cancellationSignal` is a
different clock — a workflow-side cancellation, and worker shutdown after
`shutdownGraceTime` — so the two are honoured together.

| `UnitMeta` field | Value                                                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`             | `activityInfo().base64TaskToken` — identifies one activity task attempt; uniqueness is Temporal's guarantee |
| `traceId`        | the workflow id, falling back to the activity id for an activity with no workflow                           |

A workflow id would be wrong as the `id` twice over: an activity is retried
under the same execution, and Temporal lets a workflow id be reused once an
execution closes. It is the correlation id — stable across every retry — which
is what `traceId` is for.

## The drain, and the deadline

`Serving.drain(signal)` calls `worker.shutdown()` — polling stops at once,
in-flight activities run to completion — then waits on `worker.run()`
**raced against the kernel's deadline `signal`**, and keeps the signal so
`stop()` is released by the same abort. `run()` settles on Temporal's own
`shutdownForceTime`, not the kernel's `drainTimeoutMs`; without the race, an
activity that never finishes would hold `Serving.stop` past the kernel's
deadline.

When the deadline wins, the runtime returns and the worker is still alive.
`@temporalio/worker` exposes no public forced shutdown
(`Worker.forceShutdown$` is `protected`, `Runtime.shutdown()` is
process-global), so stopping the wait is the only escalation: the kernel gets
its thread back on time, reports the activity `abandoned`, and the worker
keeps winding down on Temporal's clock until the process exits. The losing
branch's `Result` is dropped — the kernel has already settled `exited` — and
it is the one drop in the package.

`stop()` with no prior `drain` (the `RunningApp.stop()` path) has no deadline
to race and waits on `run()` alone, which is where `forceAfter` decides when
the process exits. Keep `forceAfter` at or below `drainTimeoutMs`
(default `20_000`); the package cannot enforce that, since a runtime is handed
neither the option nor the clock.

## Peer dependencies

`@btravstack/core`, `@btravstack/config`, `@btravstack/di`, `unthrown`,
`@temporalio/worker`, `@temporalio/activity`, `@temporalio/common`,
`@temporal-contract/worker`, `@temporal-contract/contract`. All nine are
peers. Node `>=20`.

## Deliberately not included

- **`Result` → activity failure.** `declareActivitiesHandler` already owns
  it: a declared contract error becomes a `nonRetryable` `ApplicationFailure`
  the workflow branches on, and anything unmodeled is retried by the
  platform's own policy. The starter does not do it a second time.
- **A forced shutdown.** There is no public one to call; the escalation is
  the released wait above.
- **A workflow client.** The starter runs a Worker; starting executions is
  `@temporal-contract/client`'s job.
