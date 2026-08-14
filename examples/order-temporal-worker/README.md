# `@btravstack/start-core` example: the order fulfillment worker

**What Temporal is for: owning a journey.** This deployment orchestrates a
**fulfillment saga** — place the order, reserve the stock, arrange the
shipping — and when a later step answers a permanent no, it walks the earlier
steps back before answering the caller. The walk-back spans services no one of
which can own it; a durable workflow is the one place the whole journey exists
as code, and survives the process that started it. The worker is served by
[`@btravstack/start-temporal`](../../packages/start-temporal) the way
`order-api` is served by `@btravstack/start-http`; the contract lives in
[`order-temporal-contract`](../order-temporal-contract), because a client that
starts these workflows needs it and needs none of this.

```
src/workflows.ts        fulfillOrder — the saga, in Temporal's deterministic sandbox
src/temporal-runtime.ts the runtime: five activities and their triage into contract errors
src/fulfillment.ts      FulfillmentModule — the two external services, as stand-ins
src/config.ts           temporalConfig / probeConfig — @btravstack/config declarations
src/module.ts           OrderTemporalModule — the composition root
src/main.ts             the process: Config.parse + connect + start + runMain
src/test-fixtures.ts    serve / fulfilling / outOfStock / noShipping, against the time-skipping env
```

## The saga

Three forward steps, each an activity calling into the application layer, and
two compensations the workflow runs **in reverse order of the steps they
undo**:

```
place ──▶ reserveStock ──▶ arrangeShipping ──▶ done
  ▲             ▲ OutOfStock?                 ▲ ShippingUnavailable?
  │             └── cancelPlacement            └── releaseStock, then cancelPlacement
```

The triage rule per step: a **declared** error is a permanent domain answer —
compensate, then re-mint it against `context.errors` so the client branches on
it by name. Temporal's own machinery tags (an activity that exhausted its
retries unmodelled, or was cancelled) are handed back as-is and re-raised, and
compensation deliberately does **not** run for them: a step that died
mid-flight left unknown state, and un-deciding what you cannot see is a second
bug, not a remedy.

The compensations' activities declare no errors at all. Compensation is the
saga un-deciding, and a step that could answer "no" would leave it stuck
half-done — so `cancelPlacement` absorbs `OrderNotFound` (compensating a
placement that never landed is a no-op, and an activity Temporal may re-run
has to answer the same both times), and whatever infrastructure trouble either
hits is undeclared, which means Temporal retries it until it works.

## One subtlety worth stealing

An `AsyncResult` is **eager** — building a step starts its activity — so every
later step in `workflows.ts` is constructed inside the `flatMap` of the one
before it. Hoist them into `const`s and the "sequence" runs as a race.

## The external services

`FulfillmentModule` provides `StockService` and `ShippingService` — in a real
system other teams' APIs, here in-memory stand-ins that always say yes and
leave a log line, because what this deployment demonstrates is the
orchestration. The specs swap in providers that say no; that is where both
compensation paths run, against the real application and the real persistence:
after a refusal, the spec reads the database through the same repository the
saga used and finds the placement gone.

## The configuration

Two [`@btravstack/config`](../../packages/config) values, and no `env.ts`:

| Variable             | Declared in                        | Default          | What it is           |
| -------------------- | ---------------------------------- | ---------------- | -------------------- |
| `TEMPORAL_ADDRESS`   | `temporalConfig` (`src/config.ts`) | `127.0.0.1:7233` | the Temporal service |
| `TEMPORAL_NAMESPACE` | `temporalConfig` (`src/config.ts`) | `default`        | must not be blank    |
| `PROBE_PORT`         | `probeConfig` (`src/config.ts`)    | `9000`           | `/livez` / `/readyz` |

The names are unchanged; what changed is where they arrive. A declaration is
**one value that is both a port token and the module serving it**, so
`imports: [temporalConfig]` provides it and `ctx.get(temporalConfig)` reads it
back — and `temporalWorkerRuntime` does exactly that for the namespace,
declaring the config in its `needs` instead of taking it as a parameter.

`main.ts` validates every config in the graph before building it, in one
report:

```ts
await Config.parse(Config.collect(OrderTemporalModule), process.env).match({
  ok: () => work(),
  errCases: (matcher) =>
    matcher.with(P.tag("config/ConfigInvalid"), (error) =>
      abort(describeIssues(error.issues)),
    ),
  defect: (cause) =>
    abort(`the configuration could not be validated: ${String(cause)}`),
});
```

Two of the three are still read from `process.env` by hand, and the comment at
those lines says why: `start` binds the probe server before it builds the
graph, and the `NativeConnection` has to be **open** before the runtime can be
handed it — so neither value can come out of a graph that does not exist yet.
Both are still declared and still validated above. Phase 2's kernel
integration is what removes them. The connection itself is not configuration:
it is a resource with an owner, opened and closed by whoever opened it, which
is why the runtime is handed one rather than resolving it.

## Running the specs

The suite runs against Temporal's **time-skipping test environment** — a real
server binary (downloaded once into a repo-local cache; the one example that
needs network on a cold cache), real Workflow Tasks, real Activity Tasks. The
saga fulfills, both refusals compensate, and the duplicate-order answer
arrives at the client as a typed contract error it can branch on by name.

```bash
pnpm --filter @btravstack/start-example-order-temporal-worker test        # the saga specs
pnpm --filter @btravstack/start-example-order-temporal-worker typecheck   # the needs gate
```

## What this deployment deliberately is not

It is not a broadcast. Every activity here is _addressed_ — the workflow asks
a specific step to happen next and waits for the answer, because the journey
has an owner and an order. When a fact just needs saying to whoever listens,
that is an event, and it lives in [`order-amqp-worker`](../order-amqp-worker).
