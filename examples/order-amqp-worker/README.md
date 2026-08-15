# `@btravstack/core` example: the order broadcast worker

**What AMQP is for: telling everyone what happened.** This deployment
broadcasts a **change stream** — every write to an order, as a fact on the
wire — and it gets those facts out without ever letting "the order committed"
and "the event was sent" disagree: the **transactional outbox** pattern, end
to end.
The consuming half is served by
[`@btravstack/amqp`](../../packages/amqp) the way `order-api` is
served by `@btravstack/http`; the contract lives in
[`order-amqp-contract`](../order-amqp-contract), because another service
binding its own queue to the `orders` exchange needs it and needs none of this.

```
src/handlers.ts        the consuming half: orderHandlers, port and provider minted by AmqpHandlers, from Logger
src/outbox-relay.ts    the publishing half: sweep the outbox, publish, mark sent — a resourceful provider
src/module.ts          OrderAmqpWorker — the composition root, an AmqpModule, a constant
src/main.ts            the process: runMain(OrderAmqpWorker), and nothing else
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

## Everything is a provider

`@btravstack/amqp`'s starter needs one thing from the application: its
**handlers, as a service**. `src/handlers.ts` is one call —
`AmqpHandlers(orderContract)("OrderHandlers")([Logger], { sync: … })` — which
mints the port (its service the record `orderContract` wants,
`WorkerInferHandlers<OrderContract>`, no injected context) and provides it
from `Logger`: the one handler is `declareHandler(orderContract,
"orderChanged", …)` closing over the logger it was built with, the way every
service in the graph is built. No port class is declared here;
`orderHandlers.port` is the port where one is needed (the needs gate). The
composition root is `AmqpModule("OrderAmqpWorker")({ contract: orderContract,
handlers: orderHandlers, imports, provides, exports })` — a `Module(...)` that
also takes the handlers provider: under the hood it imports the starter
(`amqp({ contract, handlers: orderHandlers.port })`, the runtime on
`AmqpRuntime` and the broker on `AmqpConfig`), provides `orderHandlers`, and
exports `AmqpRuntime` for `start` to resolve. There is no `needs`, no
`context.ctx.get(...)`, and no port declared here over `RuntimePort` — the
package ships it.

The **relay** is a provider too, a resourceful one: `OutboxRelay` is acquired
as the graph builds — from `Outbox`, `Logger`, the `AmqpConfig` the starter
bound and its own `relayConfig.port` (`RelayConfig`, `OUTBOX_POLL_MS`, minted
by `Config.provider("RelayConfig", schema)` since the slice is this
deployment's own) — and released when the application scope closes. Nothing resolves it, and nothing needs to; di
constructs every provider in the tree, and a resourceful one exists to be
started and stopped. It creates its own `TypedAmqpClient` rather than
receiving one as a port, because a transport connection is the transport's
own — and it is not a second connection either: `@amqp-contract/core` pools by
URL and reference-counts leases, so the relay's client and the consumer's
worker share one TCP connection, and `close()` releases a lease rather than
the socket.

That ordering is worth stating. The relay now starts **before** the consumer —
as the graph builds, where a broker it cannot reach fails startup, as it
always did — and stops **after** it, when the scope closes rather than inside
the runtime's `stop`. That is fine: the relay's client holds its own lease, so
the consumer's close does not pull the connection from under it, and pending
rows published during the drain window are safer out than abandoned to the
next boot. `drain` stays the consumer's alone — draining means "stop taking new
work", and the relay's work is outbound.

Configuration is read inside the graph, so the composition root is a
**constant**: `main.ts` is `await runMain(OrderAmqpWorker)`, and the specs boot
the same value with `env: { AMQP_URL: <this test's vhost>, OUTBOX_POLL_MS: "25" }`.
The compile-time half (`src/needs-gate.test-d.ts`) pins that `start` finds the
runtime, and that a composition which forgets to provide `orderHandlers` is
refused — by di's needs channel now, since the runtime itself has no needs
left for `start`'s gate to check (spelled with the `amqp()` primitive, since
the sugar cannot leave the handlers out).

## The environment

| Variable         | Default                 | What it is                                    |
| ---------------- | ----------------------- | --------------------------------------------- |
| `AMQP_URL`       | `amqp://127.0.0.1:5672` | the broker (`AmqpConfig`), consumer and relay |
| `PROBE_PORT`     | `9000`                  | `/livez` / `/readyz`                          |
| `OUTBOX_POLL_MS` | `200`                   | the relay's idle sleep (`RelayConfig`)        |

`OUTBOX_POLL_MS=0` is rejected at boot — a relay that never sleeps is a busy
loop — and so is anything above `60000`. A bad value, or an empty one, is a
`ConfigInvalid` the kernel reports itself: a `startFailed` event naming the
variable, and exit code 78 (`EX_CONFIG`) under `runMain`. `PROBE_PORT` is the
kernel's own, read the same way.

## Running the specs

The suite runs against a **real RabbitMQ** in a testcontainer (Docker
required): a write placed through the application's own `PlaceOrder` crosses
the outbox, the broker and the queue, and comes back as the consumer's
notification — commit order preserved, outbox drained, a cancellation
arriving as a tombstone behind its placement, and the same event delivered to
a subscriber this contract never heard of.

```bash
pnpm --filter @btravstack/example-order-amqp-worker test        # broadcast e2e
pnpm --filter @btravstack/example-order-amqp-worker typecheck   # the needs gate
```

## What this deployment deliberately is not

It is not a command queue. Nothing here asks a worker to _do_ anything — the
event is past tense, the publisher does not address a consumer, and removing
the notifier would inconvenience nobody but the notifier's users. When the
journey needs an owner — steps in order, compensation on failure — that is
orchestration, and it lives in [`order-temporal-worker`](../order-temporal-worker).
