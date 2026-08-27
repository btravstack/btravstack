# @btravstack/temporal-worker

> The **worker half** of Temporal for [`@btravstack/core`](../core) — starting
> workflows is a client's job, and belongs to `@temporal-contract/client`. One module
> providing the runtime, its configuration and its connection; one unit per
> activity attempt; and a drain that releases the kernel at the **kernel's**
> deadline, not Temporal's `shutdownForceTime`.

📖 **[Documentation](https://btravstack.github.io/btravstack/how-to/run-a-temporal-worker)** ·
[Reference](https://btravstack.github.io/btravstack/reference/temporal-worker) ·
[API Reference](https://btravstack.github.io/btravstack/api/temporal-worker/)

```sh
pnpm add @btravstack/temporal-worker @btravstack/core @btravstack/config @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common \
  @temporal-contract/worker @temporal-contract/contract
```

All nine are peer dependencies — install them. Node `>=22`.

## A worked example

<!-- doctest: prelude
import { defineActivity, defineContract, defineWorkflow } from "@temporal-contract/contract";
import { workflowsPathFromURL } from "@temporal-contract/worker/worker";
import { Module } from "@btravstack/di";
import { PlaceOrder, OrderRepository, Outbox, OrderApplicationModule } from "@btravstack/example-order-application";
import { OrderPersistenceModule } from "@btravstack/example-order-infrastructure";
import { TenantId } from "@btravstack/example-order-domain";
import { observability } from "@btravstack/observability";
import { otel } from "@btravstack/observability/otel";
import { z } from "zod";

// The contract this README's worker serves — one workflow, one activity, one
// modeled contract error.
const contract = defineContract({
  taskQueue: "orders",
  workflows: {
    placeOrder: defineWorkflow({
      input: z.object({ tenantId: z.uuidv7(), orderId: z.uuidv7(), quantity: z.number() }),
      output: z.object({ id: z.uuidv7() }),
      idempotency: "allow-duplicate",
      activities: {
        place: defineActivity({
          input: z.object({ tenantId: z.uuidv7(), orderId: z.uuidv7(), quantity: z.number() }),
          output: z.object({ id: z.uuidv7() }),
          errors: {
            OrderAlreadyPlaced: { data: z.object({ id: z.uuidv7() }), nonRetryable: true },
            InvalidOrderId: { data: z.object({ id: z.string() }), nonRetryable: true },
            InvalidQuantity: { data: z.object({ id: z.uuidv7() }), nonRetryable: true },
          },
          activityOptions: { startToCloseTimeout: "30 seconds" },
        }),
      },
    }),
  },
});

const AppModule = Module("App")({
  imports: [OrderApplicationModule, OrderPersistenceModule, observability(), otel()],
  exports: [PlaceOrder, OrderRepository, Outbox, Logger],
});
-->

```ts
import { runMain, Logger } from "@btravstack/core";
import {
  TemporalActivities,
  TemporalModule,
} from "@btravstack/temporal-worker";
import { P } from "unthrown";

// The application's half: its activities, as a service built from the use
// cases it declares — closures over them, no context read at call time — on
// the starter's own activities port, typed by the contract (a worker serves
// one activities record, so there is nothing to name).
const orderActivities = TemporalActivities(contract)(
  { place: PlaceOrder },
  {
    sync: ({ place }) => ({
      placeOrder: {
        place: (args, { errors }) =>
          place
            .execute(TenantId(args.tenantId), args.orderId, args.quantity)
            .mapErrCases((matcher) =>
              matcher
                .with(P.tag("DuplicateOrder"), (error) =>
                  errors.OrderAlreadyPlaced({ id: error.id }),
                )
                .with(P.tag("InvalidOrderId"), (error) =>
                  errors.InvalidOrderId({ id: error.id }),
                )
                .with(P.tag("InvalidQuantity"), (error) =>
                  errors.InvalidQuantity({ id: error.id }),
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

`TemporalModule` imports the starter — `TemporalRuntime`, `TemporalConfig`
bound from `TEMPORAL_ADDRESS` (default `127.0.0.1:7233`) and
`TEMPORAL_NAMESPACE` (default `default`), `TemporalConnection` opened as a
resource of the graph and closed on every exit path — provides the activities
and exports the runtime port. A service that will not answer is a modeled
`TemporalUnreachable`, exit `1`; the starter calls `declareActivitiesHandler`
itself, inside its own error qualifier, so a contract it cannot satisfy is a
startup `Err`, not a defect. `runtimeInfo()` reads `{ taskQueue, namespace }`
back once the worker is polling.

A worker polling for several workflows can be several slices instead of one
record: `TemporalWorkflowActivities(contract, key)({ name: Dep }, arm)` mints a
provider for ONE workflow's activities (or a contract-global activity),
typed by the key alone, and `TemporalActivities(contract)([...])` composes an
array of them into the same activities provider `TemporalModule` takes — the
array must cover every key the contract declares, and each piece's own port
must still be discharged (`provides`), since the composed provider's deps are
the pieces' ports, not what they close over. Two slices claiming one key are
di's duplicate-provider defect at build, which is the point: a workflow's
activities belong to exactly one slice.

## Options

`TemporalModule(name)({...})` takes `temporal()`'s options plus `activities`
and the module lists (`imports`, `provides`, `exports`, `needs`). The
`temporal()` primitive does not take `activities` as an option — it **needs**
the activities provider on its own port, which is how the composition root
supplies it:

| Option        | What it is                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `contract`    | the `temporal-contract` contract; the task queue this worker polls is read off it                                       |
| `activities`  | the activities provider — what `TemporalActivities(contract)(...)` returns for this contract                            |
| `workflows`   | where the sandbox's code comes from: `{ workflowsPath }` or `{ workflowBundle }`                                        |
| `address`     | pins the service instead of reading `TEMPORAL_ADDRESS`                                                                  |
| `namespace`   | pins the namespace instead of reading `TEMPORAL_NAMESPACE`                                                              |
| `gracePeriod` | pins `TEMPORAL_GRACE_PERIOD_MS` — Temporal's `shutdownGraceTime`, a `Duration` (default `10_000` ms)                    |
| `forceAfter`  | pins `TEMPORAL_FORCE_AFTER_MS` — Temporal's `shutdownForceTime` (default `15_000` ms); keep it under `DRAIN_TIMEOUT_MS` |

The full table — required/optional, defaults, and the reasoning — lives on
[the reference page](https://btravstack.github.io/btravstack/reference/temporal-worker),
which is this list's one detailed home.

## The drain

`worker.shutdown()` stops polling at once, but `run()` resolves only when the
last in-flight activity has finished — on Temporal's own `shutdownForceTime`.
`Serving.drain(signal)` races that wait against the kernel's deadline and
returns at whichever comes first: the kernel gets its thread back on time, the
work is reported `abandoned`, and the worker keeps winding down on Temporal's
clock until the process exits. `@temporalio/worker` exposes no public forced
shutdown, so "stop waiting" is the escalation. `Result` → activity failure is
`declareActivitiesHandler`'s and is deliberately not duplicated here. The rest
is on the [documentation site](https://btravstack.github.io/btravstack/reference/temporal-worker).

## License

[MIT](./LICENSE) © Benoit TRAVERS
