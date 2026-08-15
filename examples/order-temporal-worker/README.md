# `@btravstack/core` example: the order fulfillment worker

**What Temporal is for: owning a journey.** This deployment orchestrates a
**fulfillment saga** — place the order, reserve the stock, arrange the
shipping — and when a later step answers a permanent no, it walks the earlier
steps back before answering the caller. The walk-back spans services no one of
which can own it; a durable workflow is the one place the whole journey exists
as code, and survives the process that started it. The worker is served by
[`@btravstack/temporal`](../../packages/temporal) the way
`order-api` is served by `@btravstack/http`; the contract lives in
[`order-temporal-contract`](../order-temporal-contract), because a client that
starts these workflows needs it and needs none of this.

```
src/workflows.ts        fulfillOrder — the saga, in Temporal's deterministic sandbox
src/temporal-runtime.ts the runtime: five activities and their triage into contract errors,
                        provided on OrderTemporalRuntime by temporalModule({ contract, workflows }),
                        with TemporalConfig (the environment) and TemporalConnection (a resource)
src/fulfillment.ts      FulfillmentModule — the two external services, as stand-ins
src/module.ts           OrderTemporalWorker — the composition root, runtime included
src/main.ts             the process: runMain(OrderTemporalWorker)
src/test-fixtures.ts    serve / fulfilling / outOfStock / noShipping, against the time-skipping env
```

## The runtime is a service the graph provides

`start` takes no runtime option: it resolves the worker from a port the module
exports, declared over the kernel's `RuntimePort`. The worker's `needs` are
this application's five ports, so the port — `OrderTemporalRuntime` — is this
package's to declare, and `temporalModule({ contract, workflows })` provides
`temporalWorkerRuntime(...)` on it. Inside that module the transport is wired
like any other service: `TemporalConfig` is bound from the environment with
`Config.provider`, and `TemporalConnection` is a **resourceful** provider —
di opens the `NativeConnection` with the scope and closes it on every exit
path, startup failure included, which is what a `main.ts` opening it by hand
had to `.finally` around `runMain`. A service that will not answer is a
modeled `TemporalUnreachable` (exit `1`), not a defect: an operator can act
on it. The composition root, `OrderTemporalWorker`, is therefore a constant;
it exports the runtime's port alongside the five the activities resolve, and
`start`'s gate reads both halves off the exports (`src/needs-gate.test-d.ts`
pins a root with no runtime and one a port short). The two arguments the
module factory keeps are the deployment's static facts: `main.ts` hands
`orderContract` and the workflow module's path, a spec a per-test queue and
a prebuilt bundle.

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

## The environment

Read inside the graph — `TemporalConfig` for the first two, the kernel for
`PROBE_PORT` — never by `main.ts`. A blank or malformed value is a
`ConfigInvalid` the kernel reports as a `startFailed` event and exit `78`.

| Variable             | Default          | What it is           |
| -------------------- | ---------------- | -------------------- |
| `TEMPORAL_ADDRESS`   | `127.0.0.1:7233` | the Temporal service |
| `TEMPORAL_NAMESPACE` | `default`        | must not be blank    |
| `PROBE_PORT`         | `9000`           | `/livez` / `/readyz` |

The specs boot the real `temporalModule` with `env: { TEMPORAL_ADDRESS }`
pointing at the time-skipping server, so every test opens and closes a
connection of its own — the environment's shared `nativeConnection` is never
handed to a scope that would close it.

## Running the specs

The suite runs against Temporal's **time-skipping test environment** — a real
server binary (downloaded once into a repo-local cache; the one example that
needs network on a cold cache), real Workflow Tasks, real Activity Tasks. The
saga fulfills, both refusals compensate, and the duplicate-order answer
arrives at the client as a typed contract error it can branch on by name.

```bash
pnpm --filter @btravstack/example-order-temporal-worker test        # the saga specs
pnpm --filter @btravstack/example-order-temporal-worker typecheck   # the needs gate
```

## What this deployment deliberately is not

It is not a broadcast. Every activity here is _addressed_ — the workflow asks
a specific step to happen next and waits for the answer, because the journey
has an owner and an order. When a fact just needs saying to whoever listens,
that is an event, and it lives in [`order-amqp-worker`](../order-amqp-worker).
