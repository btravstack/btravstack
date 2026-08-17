# @btravstack/temporal

> The Temporal worker starter for [`@btravstack/core`](../core): one module
> providing the runtime, its configuration and its connection; one unit per
> activity attempt; and a drain that releases the kernel at the **kernel's**
> deadline, not Temporal's `shutdownForceTime`.

📖 **[Documentation](https://btravstack.github.io/start/how-to/run-a-temporal-worker)** ·
[Reference](https://btravstack.github.io/start/reference/temporal) ·
[API Reference](https://btravstack.github.io/start/api/temporal/)

```sh
pnpm add @btravstack/temporal @btravstack/core @btravstack/config @btravstack/di unthrown \
  @temporalio/worker @temporalio/activity @temporalio/common \
  @temporal-contract/worker @temporal-contract/contract
```

All nine are peer dependencies — install them. Node `>=20`. Not yet published:
this repository has not cut a release yet.

## A worked example

```ts
import { runMain } from "@btravstack/core";
import { TemporalActivities, TemporalModule } from "@btravstack/temporal";
import { P } from "unthrown";

// The application's half: its activities, as a service built from the use
// cases it declares — closures over them, no context read at call time — on
// the starter's own activities port, typed by the contract (a worker serves
// one activities record, so there is nothing to name).
const orderActivities = TemporalActivities(contract)([PlaceOrder], {
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
});

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
record: `TemporalWorkflowActivities(contract, key)([deps], arm)` mints a
provider for ONE workflow's activities (or a contract-global activity),
typed by the key alone, and `TemporalActivities(contract)([...])` composes an
array of them into the same activities provider `TemporalModule` takes — the
array must cover every key the contract declares, and each piece's own port
must still be discharged (`provides`), since the composed provider's deps are
the pieces' ports, not what they close over. Two slices claiming one key are
di's duplicate-provider defect at build, which is the point: a workflow's
activities belong to exactly one slice.

## The drain

`worker.shutdown()` stops polling at once, but `run()` resolves only when the
last in-flight activity has finished — on Temporal's own `shutdownForceTime`.
`Serving.drain(signal)` races that wait against the kernel's deadline and
returns at whichever comes first: the kernel gets its thread back on time, the
work is reported `abandoned`, and the worker keeps winding down on Temporal's
clock until the process exits. `@temporalio/worker` exposes no public forced
shutdown, so "stop waiting" is the escalation. `Result` → activity failure is
`declareActivitiesHandler`'s and is deliberately not duplicated here. The rest
is on the [documentation site](https://btravstack.github.io/start/reference/temporal).

## License

[MIT](./LICENSE) © Benoit TRAVERS
