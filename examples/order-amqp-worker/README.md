# `@btravstack/start-core` example: the order broadcast worker

**What AMQP is for: telling everyone what happened.** This deployment
broadcasts a fact — `order.placed` — to whoever cares to listen, and it gets
that fact onto the wire without ever letting "the order committed" and "the
event was sent" disagree: the **transactional outbox** pattern, end to end.
The consuming half is served by
[`@btravstack/start-amqp`](../../packages/start-amqp) the way `order-api` is
served by `@btravstack/start-http`; the contract lives in
[`order-amqp-contract`](../order-amqp-contract), because another service
binding its own queue to the `orders` exchange needs it and needs none of this.

```
src/outbox-relay.ts    the publishing half: sweep the outbox, publish, mark sent
src/amqp-runtime.ts    the runtime: start-amqp's consumer with the relay layered on
src/module.ts          OrderAmqpModule — the composition root
src/env.ts             process.env validated through a schema, as a Result
src/main.ts            the process: readEnv + start + runMain
src/test-fixtures.ts   serve / tapped, as Vitest fixtures, against a real RabbitMQ
```

## The pattern, in three places

**The write** is `OrderRepository.save` in `order-infrastructure`: the order
row and its `OutboxMessage` row commit in one `$tryTransaction`. There is no
"publish after save" call to forget, and no window where the order exists but
the fact of it is lost — the failure mode the naive `save(); publish();`
sequence carries by construction.

**The relay** is `src/outbox-relay.ts`: an infinite sweep — pull pending rows
in commit order, `publish("orderPlaced", …)` each to the `orders` exchange,
mark what the broker confirmed. It is deliberately **at-least-once**: a crash
between publish and mark re-publishes on the next sweep, a broker outage
leaves rows pending and the sweep after the outage drains them. What is never
possible is the inverse — a committed order whose event evaporated.

**The consumer** is one `declareHandler` on the contract's
`order-notifications` queue, reacting to the fact like any other service
would. It is intentionally the least interesting part: a broadcast's
publisher does not know it exists, and the spec proves that by binding a
_foreign_ queue to the same exchange and receiving the same event.

## Where the relay lives

`orderAmqpRuntime` layers the relay onto the runtime `start-amqp` hands back:
started after the consumer, stopped before it, so a relay that cannot reach
the broker fails startup the way a consumer that cannot would. `drain` stays
the consumer's alone — draining means "stop taking new work", and the relay's
work is outbound: pending rows are safer published during the drain window
than abandoned to the next boot.

The relay's needs are ports (`Outbox`, `Logger`), resolved from the same
application context the consumer's handler resolves — `start`'s needs gate
(`src/needs-gate.test-d.ts`) proves the composition root exports both, at
compile time.

## The environment

| Variable         | Default                 | What it is                            |
| ---------------- | ----------------------- | ------------------------------------- |
| `AMQP_URL`       | `amqp://127.0.0.1:5672` | the broker, for consumer and relay    |
| `PROBE_PORT`     | `9000`                  | `/livez` / `/readyz`                  |
| `OUTBOX_POLL_MS` | `200`                   | the relay's idle sleep between sweeps |

`OUTBOX_POLL_MS=0` is rejected at boot — a relay that never sleeps is a busy
loop, and the deployment's own spec pins that where the shared `wholeNumber`
fragment's bounds would not.

## Running the specs

The suite runs against a **real RabbitMQ** in a testcontainer (Docker
required): a write placed through the application's own `PlaceOrder` crosses
the outbox, the broker and the queue, and comes back as the consumer's
notification — commit order preserved, outbox drained, and the same event
delivered to a subscriber this contract never heard of.

```bash
pnpm --filter @btravstack/start-example-order-amqp-worker test        # broadcast e2e + env specs
pnpm --filter @btravstack/start-example-order-amqp-worker typecheck   # the needs gate
```

## What this deployment deliberately is not

It is not a command queue. Nothing here asks a worker to _do_ anything — the
event is past tense, the publisher does not address a consumer, and removing
the notifier would inconvenience nobody but the notifier's users. When the
journey needs an owner — steps in order, compensation on failure — that is
orchestration, and it lives in [`order-temporal-worker`](../order-temporal-worker).
