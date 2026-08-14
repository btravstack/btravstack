# `@btravstack/start-core` example: the order broadcast worker

**What AMQP is for: telling everyone what happened.** This deployment
broadcasts a **change stream** — every write to an order, as a fact on the
wire — and it gets those facts out without ever letting "the order committed"
and "the event was sent" disagree: the **transactional outbox** pattern, end
to end.
The consuming half is served by
[`@btravstack/start-amqp`](../../packages/start-amqp) the way `order-api` is
served by `@btravstack/start-http`; the contract lives in
[`order-amqp-contract`](../order-amqp-contract), because another service
binding its own queue to the `orders` exchange needs it and needs none of this.

```
src/outbox-relay.ts    the publishing half: sweep the outbox, publish, mark sent
src/amqp-runtime.ts    the runtime: start-amqp's consumer with the relay layered on
src/config.ts          amqpConfig / probeConfig — @btravstack/config declarations
src/module.ts          OrderAmqpModule — the composition root
src/main.ts            the process: Config.parse + start + runMain
src/test-fixtures.ts   serve / tapped, as Vitest fixtures, against a real RabbitMQ
```

## The pattern, in three places

**The write** is `OrderRepository.save` in `order-infrastructure`: the order
row and its `OutboxMessage` row commit in one `$tryTransaction`. There is no
"publish after save" call to forget, and no window where the order exists but
the fact of it is lost — the failure mode the naive `save(); publish();`
sequence carries by construction.

**The relay** is `src/outbox-relay.ts`: an infinite sweep — pull pending rows
in commit order, `publish("orderChanged", …)` each to the `orders` exchange,
mark what the broker confirmed. It is deliberately **at-least-once**: a crash
between publish and mark re-publishes on the next sweep, a broker outage
leaves rows pending and the sweep after the outage drains them. What is never
possible is the inverse — a committed order whose event evaporated.

**The consumer** is one `declareHandler` on the contract's
`order-notifications` queue, reacting to the fact like any other service
would. It is intentionally the least interesting part: a broadcast's
publisher does not know it exists, and the spec proves that by binding a
_foreign_ queue to the same exchange and receiving the same event.

## Where the relay lives, and what it takes from di

The relay resolves `Outbox` and `Logger` from the application context — the
boundary that matters — but creates its own `TypedAmqpClient` rather than
receiving one as a port, and is not itself a di provider. Both are deliberate:
a transport connection is a **runtime** concern in this repo (configured from
the environment in `main.ts`, exactly as `start-amqp` creates its worker and
`order-temporal-worker` opens its `NativeConnection`), while a di provider
holds something the _application_ depends on — which is why `OrderDatabase` is
one and this publisher is not. Nothing in the graph resolves the relay, and a
provider exists to be resolved.

It is not a second connection either: `@amqp-contract/core` pools by URL and
reference-counts leases, so the relay's client and the consumer's worker share
one TCP connection, and `close()` releases a lease rather than the socket.

## Where the relay lives

`orderAmqpRuntime` layers the relay onto the runtime `start-amqp` hands back:
started after the consumer, stopped before it, so a relay that cannot reach
the broker fails startup the way a consumer that cannot would. `drain` stays
the consumer's alone — draining means "stop taking new work", and the relay's
work is outbound: pending rows are safer published during the drain window
than abandoned to the next boot.

The relay's needs are ports (`Outbox`, `Logger`, and the two configs below),
resolved from the same application context the consumer's handler resolves —
`start`'s needs gate (`src/needs-gate.test-d.ts`) proves the composition root
exports all four, at compile time.

## The configuration

Three [`@btravstack/config`](../../packages/config) values, and no `env.ts`:

| Variable         | Declared in                             | Default                 | What it is                            |
| ---------------- | --------------------------------------- | ----------------------- | ------------------------------------- |
| `AMQP_URL`       | `amqpConfig` (`src/config.ts`)          | `amqp://127.0.0.1:5672` | the broker, for consumer and relay    |
| `OUTBOX_POLL_MS` | `outboxRelayConfig` (`outbox-relay.ts`) | `200`                   | the relay's idle sleep between sweeps |
| `PROBE_PORT`     | `probeConfig` (`src/config.ts`)         | `9000`                  | `/livez` / `/readyz`                  |

The names are unchanged; what changed is where they arrive. Each declaration
is **one value that is both a port token and the module serving it**, so
`imports: [amqpConfig]` provides it and `ctx.get(amqpConfig)` reads it back.
`main.ts` no longer knows what a broker URL is: the runtime declares the
configs in its `needs` and resolves them from the context `start` hands it,
exactly as it resolves `Outbox`. `OUTBOX_POLL_MS` is declared next to the loop
it tunes rather than in a central file — which is also why its config's
identity (`OutboxRelay`) and its prefix (`OUTBOX`) differ.

`OUTBOX_POLL_MS=0` is rejected at boot — a relay that never sleeps is a busy
loop, and its `wholeNumber(200, 1, 60_000)` lower bound says so where a port's
own bounds would not.

`main.ts` validates **every** config in the graph before building it, and
reports them together:

```ts
await Config.parse(Config.collect(OrderAmqpModule), process.env).match({
  ok: () =>
    runMain(
      start(OrderAmqpModule, {
        runtime: orderAmqpRuntime(),
        probes: { port: probePort },
      }),
    ),
  errCases: (matcher) =>
    matcher.with(P.tag("config/ConfigInvalid"), (error) =>
      abort(describeIssues(error.issues)),
    ),
  defect: (cause) =>
    abort(`the configuration could not be validated: ${String(cause)}`),
});
```

`probePort` is the one variable still read from `process.env` by hand: `start`
binds the probe server before it builds the graph, so its port cannot come out
of one. It is still declared and still validated above — see the comment at
that line, and phase 2's kernel integration.

The specs swap the environment rather than the values: `src/test-fixtures.ts`
imports `Config.source({ AMQP_URL: <this test's vhost>, OUTBOX_POLL_MS: "25" })`
where `OrderAmqpModule` imports `Config.source(process.env)`, and nothing below
it can tell the difference.

## Running the specs

The suite runs against a **real RabbitMQ** in a testcontainer (Docker
required): a write placed through the application's own `PlaceOrder` crosses
the outbox, the broker and the queue, and comes back as the consumer's
notification — commit order preserved, outbox drained, a cancellation
arriving as a tombstone behind its placement, and the same event delivered to
a subscriber this contract never heard of.

```bash
pnpm --filter @btravstack/start-example-order-amqp-worker test        # the broadcast end-to-end specs
pnpm --filter @btravstack/start-example-order-amqp-worker typecheck   # the needs gate
```

## What this deployment deliberately is not

It is not a command queue. Nothing here asks a worker to _do_ anything — the
event is past tense, the publisher does not address a consumer, and removing
the notifier would inconvenience nobody but the notifier's users. When the
journey needs an owner — steps in order, compensation on failure — that is
orchestration, and it lives in [`order-temporal-worker`](../order-temporal-worker).
