# `@btravstack/start` example: the order Temporal worker

The third deployment. The same application, the same persistence, the same
composition — driven by a durable execution engine instead of an HTTP server or
a queue. The contract it implements lives in
[`order-temporal-contract`](../order-temporal-contract), because a client that
starts these workflows needs it and needs none of this.

```
src/workflows.ts         the workflow body, in its own module because the sandbox is bundled separately
src/temporal-runtime.ts  the Runtime: start / drain / stop, and the activity that is the kernel unit
src/module.ts            OrderTemporalModule — the composition root
src/env.ts               process.env validated through a schema, as a Result
src/main.ts              the process: readEnv + connect + start + runMain
src/test-fixtures.ts     testEnv / serve / gate / tapped / unmodelled, as Vitest fixtures
```

## The point of this package

`OrderTemporalModule` is `OrderApiModule` and `OrderWorkerModule` with a
different name:

```ts
export const OrderTemporalModule = Module("OrderTemporal")({
  imports: [ApplicationModule, PersistenceModule],
  provides: [],
  exports: [PlaceOrder, FindOrder, Logger],
});
```

Nothing in `order-application` or `order-infrastructure` changed to make this
work, and nothing could have. **One process, one runtime** was already two
composition roots and two `Runtime` values; a third one, over a transport as
unlike HTTP as durable execution is, is what turns "two" into a pattern.

## The same `Err`, three transports

`DuplicateOrder` is one value. Over HTTP there is a caller waiting to be told,
so it becomes a `CONFLICT` the client receives **as a value**. On a queue there
is no caller, so the message is **parked**. Here there is a caller again — a
workflow, and behind it a client — so it becomes a **typed contract error**,
rehydrated by name with its payload intact.

| unthrown               | oRPC (`order-api`)      | queue (`order-worker`)      | Temporal (this package)                 |
| ---------------------- | ----------------------- | --------------------------- | --------------------------------------- |
| `Ok(order)`            | the procedure's output  | **ack**                     | the workflow's output                   |
| `Err(InvalidQuantity)` | `INVALID_QUANTITY`      | **dead-letter**             | `InvalidQuantity`, **non-retryable**    |
| `Err(DuplicateOrder)`  | `CONFLICT`              | **dead-letter**             | `OrderAlreadyPlaced`, **non-retryable** |
| `Defect`               | `INTERNAL_SERVER_ERROR` | **retry**, then dead-letter | **retried by the platform**, then fails |

The last column carries something the other two do not. Naming a failure here
decides not only what the caller sees but **whether the platform retries it**:
the contract declares both domain errors `nonRetryable`, so Temporal asks
exactly once. An unmodelled failure stays unnamed and the contract's
`retry.maximumAttempts` takes over — the platform doing for free what
`order-worker` hand-rolls with an attempt budget, and the sharpest form of "a
defect is the infrastructure failure, and infrastructure comes back".

## The mapping happens twice, and that is Temporal's shape

An activity-declared contract error is rehydrated **inside the workflow** and
never reaches the client on its own. A workflow-declared one is rehydrated **at
the client**. So a domain failure a caller is entitled to branch on has to be
named at both boundaries — where `order-api` triages once in `router.ts`.

Boundary one, in `src/temporal-runtime.ts` — the domain's vocabulary stops here:

```ts
ctx
  .get(PlaceOrder)
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
  );
```

Boundary two, in `src/workflows.ts` — the workflow re-mints the two domain
failures against its own declared errors and hands everything else to
`propagateActivityFailure`, which re-raises Temporal's original failure so the
platform classifies the execution exactly as it would have if the activity call
had thrown:

```ts
propagateActivityFailure(
  context.activities
    .place({ orderId: args.orderId, quantity: args.quantity })
    .mapErrCases((matcher) =>
      matcher
        .with({ errorName: "InvalidQuantity" }, (e) =>
          context.errors.InvalidQuantity({ id: e.data.id }),
        )
        .with({ errorName: "OrderAlreadyPlaced" }, (e) =>
          context.errors.OrderAlreadyPlaced({ id: e.data.id }),
        )
        .with(
          P.tag(ACTIVITY_ERROR_TAG),
          P.tag(ACTIVITY_CANCELLED_ERROR_TAG),
          (e) => e,
        ),
    ),
);
```

Every case is named at both — this repo bans `P._`, and there is no
`.otherwise()`. The two activity-machinery tags share a handler, so they are
**grouped** into one arm rather than duplicated: grouping is what
`no-catch-all-pattern` steers you toward instead of a wildcard, and it is still
an enumeration — a third machinery tag would not compile. A new domain error is
a compile error in **both** files, plus
`order-api/src/router.ts` and `order-worker/src/queue-runtime.ts`: four places,
each of which has to decide what it means.

The client's half is what makes the claim testable rather than asserted:

```ts
await client.executeWorkflow("placeOrder", { workflowId, args }).match({
  ok: () => "placed",
  errCases: (matcher) =>
    matcher
      .with(
        { errorName: "InvalidQuantity" },
        (error) => `invalid:${error.data.id}`,
      )
      .with(
        { errorName: "OrderAlreadyPlaced" },
        (error) => `conflict:${error.data.id}`,
      )
      .with(
        ...tagPatterns(WORKFLOW_START_ERROR_TAGS),
        (error) => `start:${error._tag}`,
      )
      .with(
        ...tagPatterns(WORKFLOW_RESULT_ERROR_TAGS),
        (error) => `result:${error._tag}`,
      ),
  defect: (cause) => `defect:${String(cause)}`,
});
```

## The activity is the unit

A Temporal worker polls two kinds of task. Workflow code runs in a
deterministic V8 sandbox and may not touch a database, a clock or a di
container; the **activity** is where the process leaves that sandbox and reaches
real services. So the activity is where a kernel unit belongs, and the
activity implementations are built **inside** `Runtime.start`, closing over the
`RuntimeHost` the kernel handed over:

```ts
const placeActivity =
  (host: RuntimeHost<TemporalNeeds>): ActivityImplementationFor<OrderContract, "placeOrder", "place"> =>
  (args, { errors }) =>
    host.run(metaFor(), (ctx, _signal) => /* … */);
```

That is also why `needs` is `[PlaceOrder, Logger]` rather than empty: the
activity resolves both out of the application context, and `start`'s phantom
rest-tuple gate proves the module exports them before anything runs.

## A task token is the unit; the workflow id is the trace

```ts
const metaFor = (): UnitMeta => {
  const info = activityInfo();
  return {
    kind: "activity",
    id: info.base64TaskToken,
    traceId: info.workflowExecution?.workflowId ?? info.activityId,
  };
};
```

`UnitMeta.id` must be unique per unit, and the obvious candidate — the workflow
id — is wrong twice over: an activity is retried under the same execution, and
Temporal lets a workflow id be reused once an execution has closed. `order-worker`
answers the same problem by making the _delivery_ the id rather than the
message; here the platform already mints exactly that value. A **task token**
identifies one activity task attempt, so its uniqueness is Temporal's guarantee
rather than an argument of ours.

The workflow id becomes the `traceId`, which is what `traceId` is for: the
correlation id, minted outside this process by whoever started the execution,
and stable across every retry so all three attempts join up in the log.

## Draining is real here

This is the first runtime in the repository where `Serving.drain` meets a
transport with genuine drain semantics of its own, and the two line up exactly:

```ts
const running = worker.run();

const stopPolling = (): void => {
  if (worker.raw.getState() === "RUNNING") worker.shutdown();
};

// The kernel's deadline, kept from `drain` so `stop` is released by it too.
let deadline: AbortSignal | undefined;

const stopped = (): AsyncResult<void, never> =>
  deadline === undefined ? running : releasedBy(deadline, running);

return {
  info: { taskQueue, namespace },
  drain: (signal) => {
    deadline = signal;
    stopPolling();
    return stopped();
  },
  stop: () => {
    stopPolling();
    return stopped();
  },
};
```

`worker.shutdown()` moves the worker to `DRAINING` **immediately**: polling for
new Workflow and Activity Tasks stops at once, in-flight activities run to
completion, and `run()` resolves when the last of them has. So `drain` is
`shutdown()` plus the wait, and it is a genuine wait rather than a courtesy —
`order-api`'s and `order-worker`'s drains stop accepting and have nothing left
to wait for.

`stop` is the same call made idempotent. After a drain, `running` has already
settled and awaiting it again returns at once; on the `stop()`-without-drain
path it is what shuts the worker down, with `shutdownForceTime` as the ceiling.
`stopPolling` guards on `getState()` because `shutdown()` on a worker that is
not `RUNNING` throws Temporal's `IllegalStateError`, and `stop` always runs
after `drain` on the signal path.

Three details worth writing down:

- **`running` is held, not dropped.** `TypedWorker.run()` is
  `AsyncResult<void, never>`, and an empty _error_ channel is not an empty
  _defect_ channel — a worker that dies mid-run reports a `TechnicalError` on the
  defect channel. Both methods hand it back to the kernel, which consumes it.
- **`shutdownGraceTime` is set explicitly** because Temporal's default is `0`.
  Cancellation is cooperative, so a `0` changes nothing for an activity that
  ignores the signal — but it would fight the kernel's own drain deadline for
  the same decision, and one component should own it.
- **The kernel's deadline `AbortSignal` is honoured, because waiting on `run()`
  alone cannot honour it.** `run()` settles on Temporal's clock —
  `shutdownForceTime`, 30 seconds by default — so an activity that never
  finishes would hold `stop()` well past the kernel's `drainTimeoutMs`, and the
  kernel would have no way to release this runtime. `releasedBy` races `running`
  against the signal, and the signal is kept so `stop()` is released by the same
  abort; the losing branch's `Result` is dropped, exactly as `drainApp`
  documents for its own race. `@temporalio/worker` 1.22 offers no public forced
  shutdown to escalate to — `Worker.forceShutdown$` is `protected` and
  `Runtime.shutdown()` is process-global — so what a runtime can do is stop
  waiting, leaving the worker to `shutdownForceTime` and to the entry point
  closing the connection underneath it.

The spec asserts both halves directly — the drain that completes:

```
{"type":"drained","report":{"inFlightAtStart":1,"completed":1,"abandoned":0}}
```

and the drain that runs out of time, where the exit still arrives on the
kernel's deadline rather than Temporal's:

```
{"type":"drained","report":{"inFlightAtStart":1,"completed":0,"abandoned":1}}
```

## `Serving.info` with no port and no queue in it

```ts
const info = (await app.runtimeInfo()).get(); // { taskQueue: "orders", namespace: "default" }
```

`order-api` publishes `{ port }` — `@btravstack/start-http`'s own `HttpInfo`,
since the runtime is the package's now — and `order-worker` publishes
`{ queue, concurrency }`. No two of the three shapes share a field, which is
exactly why `Info` is the runtime's own type parameter rather than anything the
kernel models. A Temporal worker's identity **is** its task queue and namespace:
the pair an operator needs to find it in the Web UI, and the pair that decides
which work it will ever be handed.

## Running it — and the one thing this example needs that the others do not

```bash
pnpm --filter @btravstack/start-example-order-temporal test        # 8 runtime specs + 7 env specs
pnpm --filter @btravstack/start-example-order-temporal test:types  # the needs gate
```

**No Docker.** A real `TypedWorker` polls a real task queue against
`@temporalio/testing`'s time-skipping test server, which is a local binary
rather than a container — the whole worker loop, real Workflow Tasks and real
Activity Tasks, with the Docker daemon quit.

**But it does need the network once.** That binary is 64 MB, downloaded on
first use and keyed by the `@temporalio` SDK version. Every other example in
this repository is entirely self-contained; this one is not, and the trade was
accepted deliberately because the alternative — `testcontainers` against a real
Temporal cluster — needs a **network pull _and_ a daemon**, which is the
objection that keeps Docker out of this repo in the first place. A cold cache
with no network fails loudly at environment creation, naming the URL.

Two things keep that cost to once:

```ts
createTimeSkippingTest({
  server: { executable: { type: "cached-download", downloadDir, ttl: "365d" } },
});
```

`downloadDir` is `<repo>/.cache/temporal-test-server` — gitignored, and a stable
path rather than the OS temp directory, which CI wipes between jobs and macOS
purges on its own schedule. `ttl` is a year rather than the default one day, so
a developer who runs the suite on Monday and again on Wednesday does not
download it twice.

Measured on this machine, Docker quit:

|                                      | Wall clock    |
| ------------------------------------ | ------------- |
| Cold cache (64 MB download included) | **7.4 s**     |
| Warm                                 | **3.8–3.9 s** |

So the binary costs about 3.5 s, once. Warm, this package is the slowest in the
repository and still under four seconds.

`src/needs-gate.test-d.ts` pins the compile-time half: `temporalWorkerRuntime`
declares `[PlaceOrder, Logger]` — two of the three ports the module exports,
because a runtime declares what _it_ needs — and a module missing either fails
`start`'s arity gate before anything runs.

Every helper the specs need is a Vitest fixture in `src/test-fixtures.ts`, so
each file opens on `describe` and each test names its dependencies in its own
parameter list. Shutting an app down is the `serve` fixture's job, which is why
no test here has a `try`/`finally`. `serve` also scopes a **fresh task queue per
test** (`withTaskQueue` + `nextTaskQueueId`): the time-skipping environment is
shared by every test in the worker process, and two workers polling one queue
would race for each other's tasks.

`src/main.ts` is the process itself. It opens the `NativeConnection`, because a
runtime is handed its transport rather than owning its lifetime — the same
reason `order-worker`'s `main.ts` creates its queue. Like both siblings' it is
typechecked by the gate rather than executed by it.

It also **closes** it, in a `.finally` on `runMain`'s promise. Whoever opens it
closes it: the runtime is handed a connection it did not open and has no claim
on, and `src/test-fixtures.ts` is the proof — every test in the file boots a
fresh worker against the _one_ `testEnv.nativeConnection` it shares, so a
runtime closing what it was given would tear the environment down under the next
test. `.finally` rather than a `flatTap` because an open `NativeConnection`
holds the event loop, so the defect path is exactly the one that must still
close it; and a close that fails is written to stderr rather than surfaced, so
that teardown cannot rewrite the exit code `runMain` just set.
